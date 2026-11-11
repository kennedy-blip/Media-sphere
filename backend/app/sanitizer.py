"""
Module A: Client-Side URL Sanitization & Link Sandbox (Security Layer)
Two-stage security gate: tracking-strip + SSRF/whitelist validation.
"""
from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "igsh", "si", "fbclid", "t", "ref_src", "feature",
    "is_from_webapp", "sender_device", "ref", "ref_url", "gclid",
    "msclkid", "mc_cid", "mc_eid", "yclid", "vero_id", "vero_conv",
    "s", "sc", "sp", "shem", "share", "sharer", "mkt_tok",
    "pp", "start_radio", "rv", "ab_channel",
}

WHITELIST_PATTERNS = [
    r"^(?:www\.|m\.|music\.)?youtube\.com$",
    r"^(?:www\.)?youtu\.be$",
    r"^(?:www\.|m\.|vm\.|vt\.)?tiktok\.com$",
    r"^(?:www\.)?instagram\.com$",
    r"^(?:www\.|mobile\.)?x\.com$",
    r"^(?:www\.|mobile\.)?twitter\.com$",
    r"^(?:www\.|old\.)?reddit\.com$",
    r"^(?:www\.)?redd\.it$",
    r"^(?:www\.)?pinterest\.com$",
    r"^(?:www\.)?pin\.it$",
    r"^(?:www\.|player\.)?vimeo\.com$",
    r"^(?:www\.|clips\.|m\.)?twitch\.tv$",
    r"^(?:www\.|m\.|fb\.|web\.)?facebook\.com$",
    r"^(?:www\.)?fb\.watch$",
    r"^(?:www\.)?linkedin\.com$",
]

WHITELIST_REGEX = re.compile("|".join(f"(?:{p})" for p in WHITELIST_PATTERNS), re.IGNORECASE)

BLOCKED_HOSTS = {"localhost", "metadata.google.internal", "metadata"}
BLOCKED_IP_RANGES = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fc00::/7"),
]
BLOCKED_IPS = {"169.254.169.254", "100.100.100.200", "fd00:ec2::254"}


def extract_youtube_video_id(url: str) -> str | None:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        for p in ("www.", "m.", "music."):
            if host.startswith(p):
                host = host[len(p):]
        if host == "youtu.be":
            segs = [s for s in parsed.path.split("/") if s]
            if segs and re.match(r"^[\w-]{11}$", segs[0]):
                return segs[0]
        if host == "youtube.com":
            qs = dict(parse_qsl(parsed.query))
            v = qs.get("v")
            if v and re.match(r"^[\w-]{11}$", v):
                return v
            segs = [s for s in parsed.path.split("/") if s]
            if len(segs) >= 2 and segs[0] in ("shorts", "embed", "live", "v"):
                if re.match(r"^[\w-]{11}$", segs[1]):
                    return segs[1]
    except Exception:
        pass
    return None


def strip_tracking_params(url: str) -> str:
    """Remove all tracking query vectors (and playlist mix params on single-video YouTube URLs)."""
    parsed = urlparse(url)
    yt_id = extract_youtube_video_id(url)
    query_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    cleaned = []
    for k, v in query_pairs:
        low = k.lower()
        if low in TRACKING_PARAMS or low.startswith("utm_"):
            continue
        if yt_id and low in ("list", "index"):
            continue
        cleaned.append((k, v))
    new_query = urlencode(cleaned)
    return urlunparse(parsed._replace(query=new_query))


def is_blocked_ip(host: str) -> bool:
    clean = host.strip("[]").lower()
    if clean in BLOCKED_IPS or clean in BLOCKED_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(clean)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_reserved:
            return True
        return any(ip in net for net in BLOCKED_IP_RANGES)
    except ValueError:
        return False


def detect_platform(host: str) -> str:
    h = host.lower().strip(".")
    changed = True
    while changed:
        changed = False
        for prefix in ("www.", "m.", "music.", "mobile.", "old.", "clips.", "fb.", "web.", "player."):
            if h.startswith(prefix):
                h = h[len(prefix):]
                changed = True
    mapping = {
        "youtube.com": "youtube",
        "youtu.be": "youtube",
        "tiktok.com": "tiktok",
        "vm.tiktok.com": "tiktok",
        "vt.tiktok.com": "tiktok",
        "instagram.com": "instagram",
        "x.com": "x",
        "twitter.com": "x",
        "reddit.com": "reddit",
        "redd.it": "reddit",
        "pinterest.com": "pinterest",
        "pin.it": "pinterest",
        "vimeo.com": "vimeo",
        "twitch.tv": "twitch",
        "facebook.com": "facebook",
        "fb.watch": "facebook",
        "linkedin.com": "linkedin",
    }
    return mapping.get(h, "unknown")


def validate_url(raw_url: str) -> dict:
    if not raw_url or not raw_url.strip():
        return {"valid": False, "sanitized_url": None, "platform": None, "error": "Empty URL"}

    url = raw_url.strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        return {"valid": False, "sanitized_url": None, "platform": None, "error": "Invalid URL format"}

    if parsed.scheme.lower() != "https":
        return {"valid": False, "sanitized_url": None, "platform": None,
                "error": "Only https:// URLs are allowed"}

    host = (parsed.hostname or "").lower()
    if not host:
        return {"valid": False, "sanitized_url": None, "platform": None, "error": "Missing hostname"}

    if is_blocked_ip(host):
        return {"valid": False, "sanitized_url": None, "platform": None,
                "error": "URL resolves to a blocked internal address (SSRF protection)"}

    if not WHITELIST_REGEX.match(host):
        return {"valid": False, "sanitized_url": None, "platform": None,
                "error": f"Domain '{host}' is not in the allowed whitelist"}

    sanitized = strip_tracking_params(url)
    platform = detect_platform(host)
    return {"valid": True, "sanitized_url": sanitized, "platform": platform, "error": None}


def parse_batch_input(text: str) -> list[str]:
    if not text:
        return []
    parts = re.split(r"[\n,]+", text)
    return [p.strip() for p in parts if p.strip()]
