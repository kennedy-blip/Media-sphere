"""
Job queue: Redis/Celery when available, in-memory threaded executor otherwise.
Emits progress events consumed by the WebSocket broadcaster.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .extractor import extract_metadata
from .processor import create_placeholder_file, cleanup_old_files
from .transcriber import transcribe_audio

# Optional Redis/Celery
try:
    import redis  # type: ignore
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
USE_CELERY = os.environ.get("USE_CELERY", "false").lower() == "true"

jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
# asyncio event loop bridge for WS broadcasts
_broadcast_queue: asyncio.Queue | None = None
_loop: asyncio.AbstractEventLoop | None = None


def set_event_loop(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue):
    global _broadcast_queue, _loop
    _loop = loop
    _broadcast_queue = queue


def _broadcast(job: dict):
    if _loop and _broadcast_queue:
        try:
            asyncio.run_coroutine_threadsafe(_broadcast_queue.put(dict(job)), _loop)
        except RuntimeError:
            pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_job(url: str, sanitized_url: str, platform: str, resolution: str, fmt: str,
               trim_start: str | None, trim_end: str | None,
               generate_subtitles: bool, generate_summary: bool) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "url": url,
        "sanitized_url": sanitized_url,
        "platform": platform,
        "title": "Extracting…",
        "status": "queued",
        "progress": 0.0,
        "resolution": resolution,
        "format": fmt,
        "trim_start": trim_start,
        "trim_end": trim_end,
        "generate_subtitles": generate_subtitles,
        "generate_summary": generate_summary,
        "speed_mbps": 0.0,
        "eta_seconds": None,
        "error": None,
        "created_at": _now(),
        "updated_at": _now(),
        "thumbnail": None,
        "creator": None,
        "duration": None,
        "file_size": None,
        "transcript": None,
        "summary": None,
        "srt": None,
        "download_url": None,
        "file_path": None,
        "cancelled": False,
    }
    with _jobs_lock:
        jobs[job_id] = job
    _broadcast(job)
    # Dispatch: Celery if enabled + Redis reachable, else thread
    if USE_CELERY and HAS_REDIS:
        try:
            _dispatch_celery(job_id)
            return job
        except Exception:
            pass
    t = threading.Thread(target=_run_job, args=(job_id,), daemon=True)
    t.start()
    return job


def _update(job_id: str, **kwargs):
    with _jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return None
        job.update(kwargs)
        job["updated_at"] = _now()
        snapshot = dict(job)
    _broadcast(snapshot)
    return snapshot


def _run_job(job_id: str):
    """Simulated + real pipeline: extracting -> trimming -> transcribing -> ready."""
    with _jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        sanitized = job["sanitized_url"]
        platform = job["platform"]

    # Stage 1: Extracting
    _update(job_id, status="extracting", progress=5.0)
    meta = extract_metadata(sanitized, platform)
    _update(job_id, title=meta["title"], thumbnail=meta.get("thumbnail"),
            creator=meta.get("creator"), duration=meta.get("duration"), progress=25.0)

    # Stage 2: Downloading/Trimming (progress ticks)
    _update(job_id, status="trimming", progress=30.0)
    for p in range(30, 80, 5):
        with _jobs_lock:
            if jobs[job_id].get("cancelled"):
                _update(job_id, status="cancelled", progress=float(p))
                return
        _update(job_id, progress=float(p), speed_mbps=round(2.0 + (p % 7) * 0.8, 1),
                eta_seconds=max(1, int((100 - p) * 0.4)))
        time.sleep(0.25)

    # Create output file (real ffmpeg if available, else placeholder)
    file_path = create_placeholder_file(job_id, meta["title"], job["format"], meta.get("duration") or 300)
    try:
        size = os.path.getsize(file_path)
    except OSError:
        size = 50_000

    # Stage 3: Transcribing (if AI enabled)
    transcript = summary = srt = None
    if job.get("generate_subtitles") or job.get("generate_summary"):
        _update(job_id, status="transcribing", progress=82.0)
        for p in range(82, 97, 5):
            with _jobs_lock:
                if jobs[job_id].get("cancelled"):
                    _update(job_id, status="cancelled", progress=float(p))
                    return
            _update(job_id, progress=float(p))
            time.sleep(0.2)
        result = transcribe_audio(file_path, job_id)
        transcript = result.get("transcript")
        srt = result.get("srt")
        summary = result.get("summary") if job.get("generate_summary") else None

    _update(job_id, status="ready", progress=100.0, speed_mbps=0.0, eta_seconds=0,
            file_size=size, file_path=file_path, transcript=transcript,
            summary=summary, srt=srt, download_url=f"/api/v1/jobs/{job_id}/download")
    cleanup_old_files()


def _dispatch_celery(job_id: str):
    """Celery dispatch (production path when Redis broker available)."""
    from celery import Celery  # type: ignore
    celery_app = Celery("mediasphere", broker=REDIS_URL, backend=REDIS_URL)

    @celery_app.task(name="mediasphere.process_job")
    def process_job(jid: str):
        _run_job(jid)

    process_job.delay(job_id)


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        j = jobs.get(job_id)
        return dict(j) if j else None


def list_jobs() -> list[dict]:
    with _jobs_lock:
        return sorted((dict(j) for j in jobs.values()), key=lambda j: j["created_at"], reverse=True)


def cancel_job(job_id: str) -> bool:
    with _jobs_lock:
        job = jobs.get(job_id)
        if not job or job["status"] in ("ready", "failed", "cancelled"):
            return False
        job["cancelled"] = True
        job["status"] = "cancelled"
        job["updated_at"] = _now()
        snapshot = dict(job)
    _broadcast(snapshot)
    return True


def delete_job(job_id: str) -> bool:
    with _jobs_lock:
        job = jobs.pop(job_id, None)
    if job and job.get("file_path"):
        try:
            os.remove(job["file_path"])
        except OSError:
            pass
    return job is not None
