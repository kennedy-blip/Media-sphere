"""
Job queue: Redis/Celery when available, threaded executor otherwise.
Runs real yt-dlp + FFmpeg + subtitle/Whisper pipeline (test mock only when MEDIASPHERE_TEST_MOCK=true).
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .extractor import download_stream, extract_metadata, is_test_mock_enabled
from .processor import (
    STORAGE_DIR,
    cleanup_old_files,
    convert_media,
    create_placeholder_file,
    has_ffmpeg,
    trim_media,
)
from .transcriber import transcribe_audio

try:
    import redis  # type: ignore
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
USE_CELERY = os.environ.get("USE_CELERY", "false").lower() == "true"
REDIS_JOBS_KEY = "mediasphere:jobs"

jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

Subscriber = tuple[asyncio.AbstractEventLoop, asyncio.Queue]
_subscribers: set[Subscriber] = set()
_sub_lock = threading.Lock()


def _get_redis():
    if not (USE_CELERY and HAS_REDIS):
        return None
    try:
        client = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=1.5)
        client.ping()
        return client
    except Exception:
        return None


def subscribe() -> Subscriber:
    entry: Subscriber = (asyncio.get_running_loop(), asyncio.Queue(maxsize=256))
    with _sub_lock:
        _subscribers.add(entry)
    return entry


def unsubscribe(entry: Subscriber) -> None:
    with _sub_lock:
        _subscribers.discard(entry)


def _enqueue_safe(q: asyncio.Queue, payload: dict) -> None:
    if q.full():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        pass


def _broadcast(job: dict) -> None:
    snapshot = dict(job)
    with _sub_lock:
        subs = list(_subscribers)
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(_enqueue_safe, q, snapshot)
        except RuntimeError:
            unsubscribe((loop, q))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist(job: dict) -> None:
    r = _get_redis()
    if r is not None:
        try:
            r.hset(REDIS_JOBS_KEY, job["id"], json.dumps(job))
        except Exception:
            pass


def create_job(
    url: str,
    sanitized_url: str,
    platform: str,
    resolution: str,
    fmt: str,
    trim_start: str | None,
    trim_end: str | None,
    generate_subtitles: bool,
    generate_summary: bool,
) -> dict:
    job_id = uuid.uuid4().hex[:12]
    now = _now()
    job: dict[str, Any] = {
        "id": job_id,
        "url": url,
        "sanitized_url": sanitized_url,
        "platform": platform,
        "title": "Extracting live metadata…",
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
        "created_at": now,
        "updated_at": now,
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
    _persist(job)
    _broadcast(job)

    if _get_redis() is not None:
        try:
            from .celery_app import process_job
            process_job.delay(job_id)
            return dict(job)
        except Exception:
            pass

    t = threading.Thread(target=run_job, args=(job_id,), daemon=True)
    t.start()
    return dict(job)


def _is_cancelled(job_id: str) -> bool:
    job = get_job(job_id)
    if not job:
        return True
    return bool(job.get("cancelled") or job.get("status") == "cancelled")


def _update(job_id: str, **kwargs) -> dict | None:
    with _jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            r = _get_redis()
            raw = r.hget(REDIS_JOBS_KEY, job_id) if r else None
            if not raw:
                return None
            job = json.loads(raw)
            jobs[job_id] = job
        if job.get("cancelled") and kwargs.get("status") not in ("cancelled", None):
            return dict(job)
        job.update(kwargs)
        job["updated_at"] = _now()
        snapshot = dict(job)
    _persist(snapshot)
    _broadcast(snapshot)
    return snapshot


def run_job(job_id: str) -> dict | None:
    job = get_job(job_id)
    if not job:
        return None

    try:
        sanitized = job["sanitized_url"]
        platform = job["platform"]
        fmt = job["format"]
        resolution = job["resolution"]
        trim_start = job.get("trim_start")
        trim_end = job.get("trim_end")
        want_subs = bool(job.get("generate_subtitles"))
        want_summary = bool(job.get("generate_summary"))

        # Stage 1: Real metadata extraction
        _update(job_id, status="extracting", progress=8.0)
        meta = extract_metadata(sanitized, platform)
        if _is_cancelled(job_id):
            return _update(job_id, status="cancelled")
        _update(
            job_id,
            title=meta["title"],
            thumbnail=meta.get("thumbnail"),
            creator=meta.get("creator"),
            duration=meta.get("duration"),
            progress=22.0,
        )

        # Stage 2: Real stream download + FFmpeg trimming & conversion
        _update(job_id, status="trimming", progress=26.0)
        final_path = os.path.join(STORAGE_DIR, f"{job_id}.{fmt}")

        if is_test_mock_enabled():
            for p in (40.0, 65.0, 78.0):
                if _is_cancelled(job_id):
                    return _update(job_id, status="cancelled", speed_mbps=0.0, eta_seconds=None)
                _update(job_id, progress=p, speed_mbps=3.5, eta_seconds=1)
                time.sleep(0.1)
            final_path = create_placeholder_file(job_id, meta["title"], fmt, meta.get("duration") or 120)
        else:
            def _on_dl_progress(pct: float, speed: float, eta: int | None):
                _update(job_id, progress=pct, speed_mbps=speed, eta_seconds=eta)

            raw_path = download_stream(sanitized, STORAGE_DIR, job_id, resolution, fmt, progress_cb=_on_dl_progress)
            if not raw_path or not os.path.exists(raw_path):
                raise RuntimeError("Failed to download media stream from source")

            if _is_cancelled(job_id):
                try:
                    os.remove(raw_path)
                except OSError:
                    pass
                return _update(job_id, status="cancelled", speed_mbps=0.0, eta_seconds=None)

            _update(job_id, progress=78.0, speed_mbps=0.0, eta_seconds=2)
            processed_ok = False
            if has_ffmpeg():
                if trim_start or trim_end:
                    trimmed_path = os.path.join(STORAGE_DIR, f"{job_id}_trim.{os.path.splitext(raw_path)[1].lstrip('.') or 'mp4'}")
                    if trim_media(raw_path, trimmed_path, trim_start, trim_end):
                        processed_ok = convert_media(trimmed_path, final_path, fmt)
                        try:
                            os.remove(trimmed_path)
                        except OSError:
                            pass
                else:
                    processed_ok = convert_media(raw_path, final_path, fmt)
            else:
                os.replace(raw_path, final_path)
                processed_ok = True

            try:
                if os.path.exists(raw_path) and os.path.abspath(raw_path) != os.path.abspath(final_path):
                    os.remove(raw_path)
            except OSError:
                pass

            if not processed_ok or not os.path.exists(final_path):
                raise RuntimeError("FFmpeg trimming/conversion failed on downloaded stream")

        size = os.path.getsize(final_path)

        # Stage 3: Captions / Whisper STT + Summary
        transcript = summary = srt = None
        if want_subs or want_summary:
            _update(job_id, status="transcribing", progress=86.0, speed_mbps=0.0, eta_seconds=2)
            result = transcribe_audio(
                final_path,
                job_id=job_id,
                source_url=sanitized,
                meta=meta,
                trim_start=trim_start,
                trim_end=trim_end,
            )
            transcript = result.get("transcript")
            srt = result.get("srt") if want_subs else None
            summary = result.get("summary") if want_summary else None

        if _is_cancelled(job_id):
            return _update(job_id, status="cancelled", speed_mbps=0.0, eta_seconds=None)

        done = _update(
            job_id,
            status="ready",
            progress=100.0,
            speed_mbps=0.0,
            eta_seconds=0,
            file_size=size,
            file_path=final_path,
            transcript=transcript,
            summary=summary,
            srt=srt,
            download_url=f"/api/v1/jobs/{job_id}/download",
        )
        cleanup_old_files()
        return done
    except Exception as exc:
        return _update(
            job_id,
            status="failed",
            error=str(exc),
            speed_mbps=0.0,
            eta_seconds=None,
        )


def get_job(job_id: str) -> dict | None:
    r = _get_redis()
    if r is not None:
        try:
            raw = r.hget(REDIS_JOBS_KEY, job_id)
            if raw:
                parsed = json.loads(raw)
                with _jobs_lock:
                    jobs[job_id] = parsed
                return dict(parsed)
        except Exception:
            pass
    with _jobs_lock:
        j = jobs.get(job_id)
        return dict(j) if j else None


def list_jobs() -> list[dict]:
    r = _get_redis()
    if r is not None:
        try:
            vals = r.hvals(REDIS_JOBS_KEY)
            parsed = [json.loads(v) for v in vals]
            return sorted(parsed, key=lambda j: j["created_at"], reverse=True)
        except Exception:
            pass
    with _jobs_lock:
        return sorted((dict(j) for j in jobs.values()), key=lambda j: j["created_at"], reverse=True)


def cancel_job(job_id: str) -> bool:
    with _jobs_lock:
        job = jobs.get(job_id)
        if not job:
            r = _get_redis()
            raw = r.hget(REDIS_JOBS_KEY, job_id) if r else None
            if raw:
                job = json.loads(raw)
                jobs[job_id] = job
        if not job or job["status"] in ("ready", "failed", "cancelled"):
            return False
        job["cancelled"] = True
        job["status"] = "cancelled"
        job["speed_mbps"] = 0.0
        job["eta_seconds"] = None
        job["updated_at"] = _now()
        snapshot = dict(job)
    _persist(snapshot)
    _broadcast(snapshot)
    return True


def delete_job(job_id: str) -> bool:
    with _jobs_lock:
        job = jobs.pop(job_id, None)
    r = _get_redis()
    if r is not None:
        try:
            r.hdel(REDIS_JOBS_KEY, job_id)
        except Exception:
            pass
    if job and job.get("file_path"):
        try:
            os.remove(job["file_path"])
        except OSError:
            pass
    return job is not None
