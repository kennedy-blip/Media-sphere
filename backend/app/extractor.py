"""
Module B: Multi-Platform Extraction Engine (yt-dlp live extraction).
Live network extraction is enabled by default; offline mock fallback is used ONLY
when MEDIASPHERE_TEST_MOCK=true is set explicitly for firewalled unit tests.
"""
from __future__ import annotations

import hashlib
import os
import urllib.request
import json
from typing import Any

from .processor import get_ffmpeg_bin

try:
    import yt_dlp  # type: ignore
    HAS_YTDLP = True
except ImportError:
    HAS_YTDLP = False


def is_test_mock_enabled() -> bool:
    return os.environ.get("MEDIASPHERE_TEST_MOCK", "false").lower() in ("1", "true", "yes")


def _mock_metadata(url: str, platform: str) -> dict[str, Any]:
    """Deterministic fixture metadata strictly for offline unit tests (MEDIASPHERE_TEST_MOCK=true)."""
    h = hashlib.md5(url.encode()).hexdigest()
    seed = int(h[:8], 16)
    duration = 90 + (seed % 300)
    return {
        "title": f"Test Media Fixture ({platform})",
        "description": f"Offline test fixture for {url}",
        "creator": f"@{platform}_creator",
        "avatar": f"https://i.pravatar.cc/150?u={h[:12]}",
        "thumbnail": f"https://picsum.photos/seed/{h[:8]}/640/360",
        "views": 1000 + (seed % 500_000),
        "likes": 250,
        "upload_date": "2026-10-15",
        "tags": [platform, "test"],
        "duration": duration,
        "formats": _default_formats(duration),
    }


def _default_formats(duration: int) -> list[dict]:
    scale = max(1, duration // 180)
    return [
        {"format_id": "2160p", "label": "Best (4K)", "ext": "mp4", "resolution": "2160p", "filesize": 150_000_000 * scale, "fps": 60},
        {"format_id": "1080p", "label": "1080p", "ext": "mp4", "resolution": "1080p", "filesize": 60_000_000 * scale, "fps": 30},
        {"format_id": "720p", "label": "720p", "ext": "mp4", "resolution": "720p", "filesize": 30_000_000 * scale, "fps": 30},
        {"format_id": "480p", "label": "480p", "ext": "mp4", "resolution": "480p", "filesize": 15_000_000 * scale, "fps": 30},
        {"format_id": "360p", "label": "360p", "ext": "mp4", "resolution": "360p", "filesize": 8_000_000 * scale, "fps": 30},
        {"format_id": "audio", "label": "Audio Best MP3/WAV", "ext": "mp3", "resolution": "audio", "filesize": 4_000_000 * scale, "abr": 192},
    ]


def _fmt_upload_date(raw: str | None) -> str | None:
    if not raw:
        return None
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    return raw


def extract_metadata(url: str, platform: str) -> dict[str, Any]:
    """Extract real live metadata via yt-dlp."""
    if is_test_mock_enabled():
        return _mock_metadata(url, platform)

    if not HAS_YTDLP:
        raise RuntimeError("yt-dlp is not installed on the backend server")

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
        "socket_timeout": 12,
        "retries": 2,
        "js_runtimes": {"node": {}},
        "extractor_args": {"youtube": {"player_client": ["android_vr", "ios", "tv", "mweb"]}},
    }
    proxy = os.environ.get("YTDLP_PROXY") or os.environ.get("HTTPS_PROXY")
    if proxy:
        ydl_opts["proxy"] = proxy
    ffmpeg_bin = get_ffmpeg_bin()
    if ffmpeg_bin:
        ydl_opts["ffmpeg_location"] = ffmpeg_bin

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                raise RuntimeError("No media info returned from source URL")
            if "entries" in info and info["entries"]:
                info = next((e for e in info["entries"] if e), info)

            formats = []
            seen = set()
            for f in reversed(info.get("formats") or []):
                height = f.get("height")
                res = f"{height}p" if height else ("audio" if f.get("acodec") != "none" else None)
                if not res or res in seen:
                    continue
                seen.add(res)
                formats.append({
                    "format_id": str(f.get("format_id") or res),
                    "label": f.get("format_note") or res,
                    "ext": f.get("ext") or "mp4",
                    "resolution": res,
                    "filesize": f.get("filesize") or f.get("filesize_approx"),
                    "fps": f.get("fps"),
                    "abr": f.get("abr"),
                })
            if not formats:
                formats = _default_formats(int(info.get("duration") or 240))

            return {
                "title": info.get("title") or "Untitled",
                "description": (info.get("description") or "")[:2000],
                "creator": info.get("uploader") or info.get("channel") or info.get("creator") or platform,
                "avatar": info.get("channel_avatar") or info.get("uploader_avatar"),
                "thumbnail": info.get("thumbnail"),
                "views": info.get("view_count"),
                "likes": info.get("like_count"),
                "upload_date": _fmt_upload_date(info.get("upload_date")),
                "tags": (info.get("tags") or [])[:20],
                "duration": int(info["duration"]) if info.get("duration") else None,
                "formats": formats,
            }
    except Exception as exc:
        raise RuntimeError(f"Live extraction failed ({exc}). Ensure the server has internet access and the media is public.") from exc


def extract_platform_subtitles(url: str) -> list[dict[str, Any]]:
    """Fetch real timed captions via yt-dlp subtitles/automatic_captions when available."""
    if is_test_mock_enabled() or not HAS_YTDLP:
        return []
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 10,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return []
            subs = info.get("subtitles") or {}
            auto = info.get("automatic_captions") or {}
            tracks = None
            for lang_dict in (subs, auto):
                for key in ("en", "en-US", "en-GB", "en-orig"):
                    if key in lang_dict:
                        tracks = lang_dict[key]
                        break
                if tracks:
                    break
                if lang_dict:
                    tracks = next(iter(lang_dict.values()))
                    break
            if not tracks:
                return []
            json3_track = next((t for t in tracks if t.get("ext") == "json3" and t.get("url")), None)
            target = json3_track or next((t for t in tracks if t.get("url")), None)
            if not target:
                return []
            req = urllib.request.Request(target["url"], headers={"User-Agent": "Mozilla/5.0"})
            raw = urllib.request.urlopen(req, timeout=8).read().decode("utf-8", errors="ignore")
            if target.get("ext") == "json3" or raw.lstrip().startswith("{"):
                parsed = json.loads(raw)
                cues = []
                for ev in parsed.get("events", []):
                    segs = ev.get("segs")
                    if not segs or ev.get("tStartMs") is None:
                        continue
                    txt = "".join(s.get("utf8", "") for s in segs).strip()
                    if txt:
                        st = ev["tStartMs"] / 1000.0
                        dur = (ev.get("dDurationMs") or 2500) / 1000.0
                        cues.append({"start": st, "end": st + dur, "text": " ".join(txt.split())})
                return cues
    except Exception:
        return []
    return []


def download_stream(
    url: str,
    output_dir: str,
    job_id: str,
    resolution: str,
    fmt: str,
    progress_cb=None,
) -> str | None:
    """Download real media stream via yt-dlp."""
    if is_test_mock_enabled():
        return None
    if not HAS_YTDLP:
        raise RuntimeError("yt-dlp is not installed")

    os.makedirs(output_dir, exist_ok=True)
    outtmpl = os.path.join(output_dir, f"{job_id}_raw.%(ext)s")

    def _hook(d: dict[str, Any]):
        if progress_cb and d.get("status") == "downloading":
            downloaded = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            speed = (d.get("speed") or 0) / (1024 * 1024)
            eta = d.get("eta")
            pct = 28.0 + (downloaded / total) * 48.0 if total > 0 else 45.0
            progress_cb(min(76.0, round(pct, 1)), round(speed, 1), int(eta) if eta is not None else None)

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": get_format_string(resolution, fmt),
        "outtmpl": outtmpl,
        "merge_output_format": "mp4" if fmt == "mp4" and resolution != "audio" else None,
        "socket_timeout": 15,
        "retries": 3,
        "progress_hooks": [_hook],
        "js_runtimes": {"node": {}},
        "extractor_args": {"youtube": {"player_client": ["android_vr", "ios", "tv", "mweb"]}},
    }
    proxy = os.environ.get("YTDLP_PROXY") or os.environ.get("HTTPS_PROXY")
    if proxy:
        ydl_opts["proxy"] = proxy
    ffmpeg_bin = get_ffmpeg_bin()
    if ffmpeg_bin:
        ydl_opts["ffmpeg_location"] = ffmpeg_bin

    with yt_dlp.YoutubeDL({k: v for k, v in ydl_opts.items() if v is not None}) as ydl:
        info = ydl.extract_info(url, download=True)
        if info:
            prepared = ydl.prepare_filename(info)
            if os.path.exists(prepared):
                return prepared
    for fname in os.listdir(output_dir):
        if fname.startswith(f"{job_id}_raw."):
            return os.path.join(output_dir, fname)
    return None


def get_format_string(resolution: str, fmt: str) -> str:
    if resolution == "audio" or fmt in ("mp3", "wav"):
        return "bestaudio/best"
    res_map = {
        "2160p": "bv*[height<=2160]+ba/b[height<=2160]/b",
        "1080p": "bv*[height<=1080]+ba/b[height<=1080]/b",
        "720p": "bv*[height<=720]+ba/b[height<=720]/b",
        "480p": "bv*[height<=480]+ba/b[height<=480]/b",
        "360p": "bv*[height<=360]+ba/b[height<=360]/b",
        "best": "bv*+ba/b",
    }
    return res_map.get(resolution, "bv*[height<=1080]+ba/b[height<=1080]/b")
