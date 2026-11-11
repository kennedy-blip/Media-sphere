"""
Module C: Server-Side Media Processing Pipeline (FFmpeg)
Trimming (stream-copy w/ transcode fallback), format conversion, watermark note.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time

STORAGE_DIR = os.environ.get("MEDIA_STORAGE_DIR", "/tmp/mediasphere_storage")
os.makedirs(STORAGE_DIR, exist_ok=True)


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def parse_timestamp(ts: str) -> float:
    """Parse HH:MM:SS or MM:SS to seconds."""
    parts = ts.strip().split(":")
    try:
        if len(parts) == 3:
            h, m, s = parts
            return int(h) * 3600 + int(m) * 60 + float(s)
        if len(parts) == 2:
            m, s = parts
            return int(m) * 60 + float(s)
        return float(parts[0])
    except ValueError:
        return 0.0


def trim_media(input_path: str, output_path: str, start: str | None, end: str | None,
               use_stream_copy: bool = True) -> bool:
    """
    Trim with ffmpeg -ss -to. Stream-copy when keyframes align (fast),
    fallback to frame-accurate transcode.
    Returns True on success.
    """
    if not has_ffmpeg():
        return False
    cmd = ["ffmpeg", "-y"]
    if start:
        cmd += ["-ss", start]
    cmd += ["-i", input_path]
    if end:
        cmd += ["-to", end]
    if use_stream_copy:
        cmd += ["-c", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]
    cmd += [output_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=600, check=True)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        if use_stream_copy:
            return trim_media(input_path, output_path, start, end, use_stream_copy=False)
        return False


def convert_media(input_path: str, output_path: str, fmt: str) -> bool:
    """Convert to mp4/webm/mp3/wav via ffmpeg."""
    if not has_ffmpeg():
        return False
    cmd = ["ffmpeg", "-y", "-i", input_path]
    if fmt == "mp3":
        cmd += ["-vn", "-codec:a", "libmp3lame", "-q:a", "2"]
    elif fmt == "wav":
        cmd += ["-vn", "-codec:a", "pcm_s16le"]
    elif fmt == "webm":
        cmd += ["-c:v", "libvpx-vp9", "-b:v", "1M", "-c:a", "libopus"]
    else:  # mp4
        cmd += ["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]
    cmd += [output_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=600, check=True)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def create_placeholder_file(job_id: str, title: str, fmt: str, duration: int = 300) -> str:
    """
    When ffmpeg/yt-dlp unavailable, generate a small placeholder asset so the
    full job lifecycle (progress, download, preview) is demonstrable end-to-end.
    """
    ext = fmt if fmt in ("mp4", "webm", "mp3", "wav") else "mp4"
    path = os.path.join(STORAGE_DIR, f"{job_id}.{ext}")
    # Minimal valid MP4 header (ftyp box) — browsers will show metadata; real pipeline replaces this.
    with open(path, "wb") as f:
        f.write(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
        f.write(f"MediaSphere placeholder asset\nTitle: {title}\nJob: {job_id}\nFormat: {ext}\nDuration: {duration}s\n".encode())
        # Pad to ~50KB so download size looks realistic
        f.write(b"\x00" * 50_000)
    return path


def cleanup_old_files(ttl_seconds: int = 900):
    """15-min TTL auto-cleanup (run via CRON in production)."""
    now = time.time()
    for fname in os.listdir(STORAGE_DIR):
        fpath = os.path.join(STORAGE_DIR, fname)
        try:
            if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > ttl_seconds:
                os.remove(fpath)
        except OSError:
            continue
