/**
 * Module A (client & serverless): URL Sanitization & Link Sandbox.
 * Mirrors backend/app/sanitizer.py for instant UI & API validation.
 */

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "igsh", "si", "fbclid", "ref_src", "feature", "is_from_webapp", "sender_device",
  "ref", "ref_url", "gclid", "msclkid", "mc_cid", "mc_eid", "yclid", "vero_id",
  "vero_conv", "s", "sc", "sp", "shem", "share", "sharer", "mkt_tok",
  "pp", "start_radio", "rv", "ab_channel",
]);

const WHITELIST = [
  /^(?:www\.|m\.|music\.)?youtube\.com$/i,
  /^(?:www\.)?youtu\.be$/i,
  /^(?:www\.|m\.|vm\.|vt\.)?tiktok\.com$/i,
  /^(?:www\.)?instagram\.com$/i,
  /^(?:www\.|mobile\.)?x\.com$/i,
  /^(?:www\.|mobile\.)?twitter\.com$/i,
  /^(?:www\.|old\.)?reddit\.com$/i,
  /^(?:www\.)?redd\.it$/i,
  /^(?:www\.)?pinterest\.com$/i,
  /^(?:www\.)?pin\.it$/i,
  /^(?:www\.|player\.)?vimeo\.com$/i,
  /^(?:www\.|clips\.|m\.)?twitch\.tv$/i,
  /^(?:www\.|m\.|fb\.|web\.)?facebook\.com$/i,
  /^(?:www\.)?fb\.watch$/i,
  /^(?:www\.)?linkedin\.com$/i,
];

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);
const BLOCKED_IPS = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

function isPrivateIp(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || BLOCKED_IPS.has(host)) return true;
  if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function extractYoutubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com") {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && ["shorts", "embed", "live", "v"].includes(parts[0])) {
        const id = parts[1];
        return /^[\w-]{11}$/.test(id) ? id : null;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function stripTrackingParams(raw: string): string {
  try {
    const u = new URL(raw);
    const ytId = extractYoutubeVideoId(raw);
    for (const key of Array.from(u.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith("utm_")) {
        u.searchParams.delete(key);
        continue;
      }
      // Strip 't' tracking param on X/TikTok (keep on YouTube if user didn't pass list, or strip general tracking 't')
      if (lower === "t" && !ytId) {
        u.searchParams.delete(key);
        continue;
      }
      // When a specific YouTube video ID is in the URL (e.g. youtu.be/ID?list=RD...), strip playlist/mix params so single-video extraction targets that video
      if (ytId && (lower === "list" || lower === "index" || lower === "t")) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function detectPlatform(host: string): string {
  let h = host.toLowerCase().replace(/\.$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ["www.", "m.", "music.", "mobile.", "old.", "clips.", "fb.", "web.", "player."]) {
      if (h.startsWith(prefix)) {
        h = h.slice(prefix.length);
        changed = true;
      }
    }
  }
  const map: Record<string, string> = {
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
  };
  return map[h] ?? "unknown";
}

export interface ValidationResult {
  valid: boolean;
  sanitizedUrl: string | null;
  platform: string | null;
  error: string | null;
}

export function validateUrl(raw: string): ValidationResult {
  const url = (raw || "").trim();
  if (!url) return { valid: false, sanitizedUrl: null, platform: null, error: "Empty URL" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, sanitizedUrl: null, platform: null, error: "Invalid URL format" };
  }
  if (parsed.protocol !== "https:") {
    return { valid: false, sanitizedUrl: null, platform: null, error: "Only https:// URLs are allowed" };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return { valid: false, sanitizedUrl: null, platform: null, error: "Missing hostname" };
  if (isPrivateIp(host)) {
    return { valid: false, sanitizedUrl: null, platform: null, error: "Blocked internal address (SSRF protection)" };
  }
  if (!WHITELIST.some((re) => re.test(host))) {
    return { valid: false, sanitizedUrl: null, platform: null, error: `Domain '${host}' is not whitelisted` };
  }
  return { valid: true, sanitizedUrl: stripTrackingParams(url), platform: detectPlatform(host), error: null };
}

export function parseBatchInput(text: string): string[] {
  return text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}
