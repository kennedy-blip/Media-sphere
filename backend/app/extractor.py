"""
Module B: Multi-Platform Extraction Engine
yt-dlp based metadata + stream extraction with deterministic mock fallback.
"""
from __future__ import annotations

import hashlib
import os
from typing import Any

# Try importing yt-dlp; degrade gracefully if unavailable
try:
    import yt_dlp  # type: ignore
    HAS_YTDLP = True
except ImportError:
    HAS_YTDLP = False

LIVE_EXTRACT_ENABLED = os.environ.get("ENABLE_LIVE_YTDLP", "false").lower() == "true"


def _mock_metadata(url: str, platform: str) -> dict[str, Any]:
    """Deterministic mock metadata derived from URL hash (used when live network extraction is disabled/unavailable)."""
    h = hashlib.md5(url.encode()).hexdigest()
    seed = int(h[:8], 16)
    titles = {
        "youtube": ["Building the Future of Media", "How AI Is Changing Video", "The Ultimate Creator Workflow", "Deep Dive: Platform Engineering"],
        "tiktok": ["POV: You found the best tool", "Wait for the drop", "This trick broke the internet", "Day in the life of a creator"],
        "instagram": ["Behind the scenes", "Golden hour reel", "New collection drop", "Weekend vibes"],
        "x": ["Thread: Why this matters", "Hot take on media", "Breaking: new feature", "Community update"],
        "reddit": ["Discussion: Best tools of 2026", "Showcase: My setup", "Ask: How do you edit?", "Megathread: Resources"],
        "pinterest": ["DIY Home Decor Ideas", "Minimalist Workspace", "Recipe Collection", "Travel Inspiration"],
        "vimeo": ["Short Film: Dawn", "Documentary Excerpt", "Showreel 2026", "Music Video"],
        "twitch": ["Speedrun World Record Attempt", "Chill Stream Highlights", "Esports Finals", "Creative Coding Session"],
        "facebook": ["Community Highlights", "Live Event Recap", "Family Moments", "Business Spotlight"],
        "linkedin": ["Leadership Lessons", "Industry Insights 2026", "Career Advice", "Startup Story"],
    }
    creators = {
        "youtube": ["@techbrand", "@creatorlab", "@mediastack"],
        "tiktok": ["@techbrand", "@viral.creator", "@dailyvibes"],
        "instagram": ["@techbrand", "@visual.studio", "@wanderlust"],
        "x": ["@techbrand", "@buildinpublic", "@mediastack"],
        "reddit": ["u/techbrand", "u/creator_hub", "u/mediastack"],
        "pinterest": ["@techbrand", "@inspire.daily", "@homestudio"],
        "vimeo": ["@techbrand", "@filmworks", "@studio.north"],
        "twitch": ["@techbrand", "@gameon", "@streamlab"],
        "facebook": ["TechBrand", "Creator Hub", "MediaStack"],
        "linkedin": ["TechBrand", "MediaStack Inc", "Creator Lab"],
    }
    title_pool = titles.get(platform, titles["youtube"])
    creator_pool = creators.get(platform, creators["youtube"])
    title = title_pool[seed % len(title_pool)]
    creator = creator_pool[seed % len(creator_pool)]
    views = 1000 + (seed % 5_000_000)
    likes = int(views * 0.08)
    duration = 90 + (seed % 810)
    tags = ["media", "creator", "tech", "2026", platform, "viral", "trending"]
    return {
        "title": title,
        "description": (
            f"Extracted from {platform} — {title}. "
            "Sanitized media preview ready for FFmpeg trimming, format conversion, and Faster-Whisper transcription."
        ),
        "creator": creator,
        "avatar": f"https://i.pravatar.cc/150?u={h[:12]}",
        "thumbnail": f"https://picsum.photos/seed/{h[:8]}/640/360",
        "views": views,
        "likes": likes,
        "upload_date": "2026-10-15",
        "tags": tags,
        "duration": duration,
        "formats": _mock_formats(duration),
    }


def _mock_formats(duration: int) -> list[dict]:
    scale = max(1, duration // 180)
    return [
        {"format_id": "bestvideo", "label": "Best (4K)", "ext": "mp4", "resolution": "2160p", "filesize": 150_000_000 * scale, "fps": 60},
        {"format_id": "1080p", "label": "1080p", "ext": "mp4", "resolution": "1080p", "filesize": 60_000_000 * scale, "fps": 30},
        {"format_id": "720p", "label": "720p", "ext": "mp4", "resolution": "720p", "filesize": 30_000_000 * scale, "fps": 30},
        {"format_id": "480p", "label": "480p", "ext": "mp4", "resolution": "480p", "filesize": 15_000_000 * scale, "fps": 30},
        {"format_id": "360p", "label": "360p", "ext": "mp4", "resolution": "360p", "filesize": 8_000_000 * scale, "fps": 30},
        {"format_id": "audio-320", "label": "Audio 320kbps MP3", "ext": "mp3", "resolution": "audio", "filesize": 4_000_000 * scale, "abr": 320},
        {"format_id": "audio-128", "label": "Audio 128kbps AAC", "ext": "m4a", "resolution": "audio", "filesize": 1_800_000 * scale, "abr": 128},
    ]


def extract_metadata(url: str, platform: str) -> dict[str, Any]:
    """Extract metadata via yt-dlp when live extraction is enabled & reachable, else deterministic fallback."""
    if HAS_YTDLP and LIVE_EXTRACT_ENABLED:
        try:
            ydl_opts = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "extract_flat": False,
                "socket_timeout": 6,
                "retries": 1,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if info:
                    formats = []
                    for f in info.get("formats", [])[:30]:
                        formats.append({
                            "format_id": f.get("format_id"),
                            "label": f.get("format_note") or f"{f.get('height', '?')}p",
                            "ext": f.get("ext"),
                            "resolution": f"{f.get('height')}p" if f.get("height") else "audio",
                            "filesize": f.get("filesize") or f.get("filesize_approx"),
                            "fps": f.get("fps"),
                            "abr": f.get("abr"),
                        })
                    if not formats:
                        formats = _mock_formats(info.get("duration") or 300)
                    return {
                        "title": info.get("title") or "Untitled",
                        "description": (info.get("description") or "")[:2000],
                        "creator": info.get("uploader") or info.get("channel") or "unknown",
                        "avatar": info.get("channel_avatar") or info.get("uploader_avatar"),
                        "thumbnail": info.get("thumbnail"),
                        "views": info.get("view_count"),
                        "likes": info.get("like_count"),
                        "upload_date": info.get("upload_date"),
                        "tags": (info.get("tags") or [])[:20],
                        "duration": info.get("duration"),
                        "formats": formats,
                    }
        except Exception:
            pass
    return _mock_metadata(url, platform)


def download_stream(url: str, output_dir: str, job_id: str, resolution: str, fmt: str) -> str | None:
    """Download media stream via yt-dlp when live extraction is enabled & reachable."""
    if not (HAS_YTDLP and LIVE_EXTRACT_ENABLED):
        return None
    outtmpl = os.path.join(output_dir, f"{job_id}_raw.%(ext)s")
    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "format": get_format_string(resolution, fmt),
        "outtmpl": outtmpl,
        "socket_timeout": 10,
        "retries": 2,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info:
                prepared = ydl.prepare_filename(info)
                if os.path.exists(prepared):
                    return prepared
        for fname in os.listdir(output_dir):
            if fname.startswith(f"{job_id}_raw."):
                return os.path.join(output_dir, fname)
    except Exception:
        return None
    return None


def get_format_string(resolution: str, fmt: str) -> str:
    """Map UI resolution/format to yt-dlp format string."""
    if resolution == "audio" or fmt in ("mp3", "wav"):
        return "bestaudio/best"
    res_map = {
        "2160p": "bv*[height<=2160]+ba/b",
        "1080p": "bv*[height<=1080]+ba/b",
        "720p": "bv*[height<=720]+ba/b",
        "480p": "bv*[height<=480]+ba/b",
        "360p": "bv*[height<=360]+ba/b",
        "best": "bv*+ba/b",
    }
    return res_map.get(resolution, "bv*[height<=1080]+ba/b")
