"""
Module C: Server-Side Media Processing Pipeline (FFmpeg)
Uses system ffmpeg or bundled imageio-ffmpeg static binary for real trimming & conversion.
"""
from __future__ import annotations

import math
import os
import shutil
import struct
import subprocess
import time
import wave

try:
    import imageio_ffmpeg  # type: ignore
    _IMAGEIO_FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    _IMAGEIO_FFMPEG = None

STORAGE_DIR = os.environ.get("MEDIA_STORAGE_DIR", "/tmp/mediasphere_storage")
os.makedirs(STORAGE_DIR, exist_ok=True)

MIME_TYPES = {
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
}


def get_ffmpeg_bin() -> str | None:
    sys_bin = shutil.which("ffmpeg")
    if sys_bin:
        return sys_bin
    if _IMAGEIO_FFMPEG and os.path.exists(_IMAGEIO_FFMPEG):
        return _IMAGEIO_FFMPEG
    return None


def has_ffmpeg() -> bool:
    return get_ffmpeg_bin() is not None


def media_type_for(fmt: str) -> str:
    return MIME_TYPES.get(fmt.lower(), "application/octet-stream")


def parse_timestamp(ts: str) -> float:
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
    """
    ffmpeg = get_ffmpeg_bin()
    if not ffmpeg:
        return False
    cmd = [ffmpeg, "-y"]
    if start:
        cmd += ["-ss", start]
    if end:
        cmd += ["-to", end]
    cmd += ["-i", input_path]
    if use_stream_copy:
        cmd += ["-c", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart"]
    cmd += [output_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=600, check=True)
        return os.path.exists(output_path) and os.path.getsize(output_path) > 256
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        if use_stream_copy:
            return trim_media(input_path, output_path, start, end, use_stream_copy=False)
        return False


def convert_media(input_path: str, output_path: str, fmt: str) -> bool:
    """Convert to mp4/webm/mp3/wav via ffmpeg."""
    ffmpeg = get_ffmpeg_bin()
    if not ffmpeg:
        return False
    if os.path.abspath(input_path) == os.path.abspath(output_path):
        return True
    cmd = [ffmpeg, "-y", "-i", input_path]
    if fmt == "mp3":
        cmd += ["-vn", "-codec:a", "libmp3lame", "-q:a", "2"]
    elif fmt == "wav":
        cmd += ["-vn", "-codec:a", "pcm_s16le"]
    elif fmt == "webm":
        cmd += ["-c:v", "libvpx-vp9", "-b:v", "1M", "-c:a", "libopus"]
    else:
        if input_path.lower().endswith(".mp4"):
            cmd += ["-c", "copy", "-movflags", "+faststart"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart"]
    cmd += [output_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=600, check=True)
        return os.path.exists(output_path) and os.path.getsize(output_path) > 256
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        if fmt == "mp4" and input_path.lower().endswith(".mp4"):
            # Fallback transcode if stream copy failed
            cmd2 = [ffmpeg, "-y", "-i", input_path, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", output_path]
            try:
                subprocess.run(cmd2, capture_output=True, timeout=600, check=True)
                return os.path.exists(output_path) and os.path.getsize(output_path) > 256
            except Exception:
                return False
        return False


def _write_playable_wav(path: str, duration_sec: float = 2.0) -> None:
    sample_rate = 22050
    total_samples = int(sample_rate * duration_sec)
    frames = bytearray()
    for i in range(total_samples):
        t = i / sample_rate
        envelope = min(1.0, i / 1200.0) * max(0.0, 1.0 - (i / total_samples) * 0.75)
        freq = 440.0 if t < duration_sec / 2 else 554.37
        sample = int(12000 * envelope * math.sin(2.0 * math.pi * freq * t))
        frames += struct.pack("<h", sample)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(frames))


def create_placeholder_file(job_id: str, title: str, fmt: str, duration: int = 300) -> str:
    """Used strictly when MEDIASPHERE_TEST_MOCK=true in offline test suites."""
    os.makedirs(STORAGE_DIR, exist_ok=True)
    ext = fmt if fmt in ("mp4", "webm", "mp3", "wav") else "mp4"
    path = os.path.join(STORAGE_DIR, f"{job_id}.{ext}")
    if ext in ("wav", "mp3"):
        _write_playable_wav(path, duration_sec=2.0)
        return path
    ffmpeg = get_ffmpeg_bin()
    if ffmpeg:
        cmd = [
            ffmpeg, "-y",
            "-f", "lavfi", "-i", "color=c=0x12131c:s=640x360:d=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-shortest", path,
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=20, check=True)
            if os.path.exists(path) and os.path.getsize(path) > 0:
                return path
        except Exception:
            pass
    with open(path, "wb") as f:
        f.write(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
        f.write(f"MediaSphere test asset: {title}\n".encode())
        f.write(b"\x00" * 50_000)
    return path


def cleanup_old_files(ttl_seconds: int = 900):
    if not os.path.isdir(STORAGE_DIR):
        return
    now = time.time()
    for fname in os.listdir(STORAGE_DIR):
        fpath = os.path.join(STORAGE_DIR, fname)
        try:
            if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > ttl_seconds:
                os.remove(fpath)
        except OSError:
            continue
