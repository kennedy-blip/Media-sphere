"""FastAPI routes: extraction, jobs, downloads, WebSocket progress."""
from __future__ import annotations

import asyncio
import os
import re
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from . import jobs as job_store
from .extractor import extract_metadata
from .processor import media_type_for
from .sanitizer import validate_url
from .schemas import BatchJobRequest, ExtractRequest, JobCreateRequest

router = APIRouter()
ws_router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok", "service": "mediasphere-api", "version": "1.0.0"}


@router.post("/extract")
def extract(req: ExtractRequest):
    """Validate + sanitize URLs and return consolidated preview cards (Step 2)."""
    previews = []
    for raw in req.urls:
        v = validate_url(raw)
        if not v["valid"]:
            previews.append({
                "url": raw, "sanitized_url": raw, "platform": "unknown",
                "valid": False, "error": v["error"],
                "title": None, "description": None, "creator": None, "avatar": None,
                "thumbnail": None, "views": None, "likes": None, "upload_date": None,
                "tags": [], "duration": None, "formats": [],
            })
            continue
        meta = extract_metadata(v["sanitized_url"], v["platform"])
        previews.append({
            "url": raw, "sanitized_url": v["sanitized_url"], "platform": v["platform"],
            "valid": True, "error": None, **meta,
        })
    return {
        "previews": previews,
        "count": len(previews),
        "valid_count": sum(1 for p in previews if p["valid"]),
    }


@router.post("/jobs", status_code=201)
def create_job(req: JobCreateRequest):
    v = validate_url(req.url)
    if not v["valid"]:
        raise HTTPException(status_code=400, detail=v["error"])
    job = job_store.create_job(
        url=req.url,
        sanitized_url=v["sanitized_url"],
        platform=v["platform"],
        resolution=req.resolution,
        fmt=req.format.value,
        trim_start=req.trim_start,
        trim_end=req.trim_end,
        generate_subtitles=req.generate_subtitles,
        generate_summary=req.generate_summary,
    )
    return _public(job, include_transcript=True)


@router.post("/batch", status_code=201)
def create_batch(req: BatchJobRequest):
    created = []
    errors = []
    for raw in req.urls:
        v = validate_url(raw)
        if not v["valid"]:
            errors.append({"url": raw, "error": v["error"]})
            continue
        job = job_store.create_job(
            url=raw,
            sanitized_url=v["sanitized_url"],
            platform=v["platform"],
            resolution=req.resolution,
            fmt=req.format.value,
            trim_start=req.trim_start,
            trim_end=req.trim_end,
            generate_subtitles=req.generate_subtitles,
            generate_summary=req.generate_summary,
        )
        created.append(_public(job, include_transcript=True))
    return {"jobs": created, "errors": errors, "created": len(created)}


@router.get("/jobs")
def list_jobs():
    return {"jobs": [_public(j, include_transcript=True) for j in job_store.list_jobs()]}


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _public(job, include_transcript=True)


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: str):
    if not job_store.get_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    ok = job_store.cancel_job(job_id)
    return {"cancelled": ok, "id": job_id}


@router.get("/jobs/{job_id}/download")
def download_job(job_id: str, download: bool = Query(default=False)):
    job = job_store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "ready":
        raise HTTPException(status_code=409, detail=f"Job is not ready (status: {job['status']})")
    path = job.get("file_path")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File expired or missing (15-min TTL)")
    ext = job["format"]
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", job["title"])[:40].strip("_") or job_id
    filename = f"{safe_stem}.{ext}"
    mime = media_type_for(ext)
    disposition = "attachment" if download else "inline"
    return FileResponse(
        path,
        media_type=mime,
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )


@router.get("/jobs/{job_id}/transcript")
def get_transcript(job_id: str):
    job = job_store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "transcript": job.get("transcript"),
        "summary": job.get("summary"),
        "srt": job.get("srt"),
        "status": job["status"],
    }


@ws_router.websocket("/ws/queue")
async def ws_queue(ws: WebSocket):
    """Real-time progress: pushes job snapshots immediately + 200ms tick / 2s heartbeat."""
    await ws.accept()
    sub = job_store.subscribe()
    loop, queue = sub
    last_ping = loop.time()
    try:
        for j in job_store.list_jobs():
            await ws.send_json({"type": "job_update", "job": _public(j, include_transcript=True)})
        while True:
            try:
                job = await asyncio.wait_for(queue.get(), timeout=0.2)
                await ws.send_json({"type": "job_update", "job": _public(job, include_transcript=True)})
            except asyncio.TimeoutError:
                now = loop.time()
                if now - last_ping >= 2.0:
                    last_ping = now
                    await ws.send_json({"type": "ping", "ts": now})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        job_store.unsubscribe(sub)


def _public(job: dict, include_transcript: bool = False) -> dict:
    out = {
        "id": job["id"],
        "url": job["url"],
        "sanitized_url": job["sanitized_url"],
        "platform": job["platform"],
        "title": job["title"],
        "status": job["status"],
        "progress": job["progress"],
        "resolution": job["resolution"],
        "format": job["format"],
        "trim_start": job.get("trim_start"),
        "trim_end": job.get("trim_end"),
        "generate_subtitles": bool(job.get("generate_subtitles", False)),
        "generate_summary": bool(job.get("generate_summary", False)),
        "speed_mbps": job.get("speed_mbps", 0.0),
        "eta_seconds": job.get("eta_seconds"),
        "error": job.get("error"),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "thumbnail": job.get("thumbnail"),
        "creator": job.get("creator"),
        "duration": job.get("duration"),
        "file_size": job.get("file_size"),
        "download_url": job.get("download_url"),
    }
    if include_transcript:
        out["transcript"] = job.get("transcript")
        out["summary"] = job.get("summary")
        out["srt"] = job.get("srt")
    return out
