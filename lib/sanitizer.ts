/**
 * Module A (client mirror): URL Sanitization & Link Sandbox.
 * Mirrors backend/app/sanitizer.py for instant UI validation.
 */

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "igsh", "si", "fbclid", "t", "ref_src", "feature", "is_from_webapp", "sender_device",
  "ref", "ref_url", "gclid", "msclkid", "mc_cid", "mc_eid", "yclid", "s", "sc", "sp",
]);

const WHITELIST = [
  /^(www\.)?youtube\.com$/i, /^(www\.)?youtu\.be$/i, /^(www\.)?tiktok\.com$/i,
  /^(www\.)?instagram\.com$/i, /^(www\.)?x\.com$/i, /^(www\.)?twitter\.com$/i,
  /^(www\.)?reddit\.com$/i, /^(www\.)?pinterest\.com$/i, /^(www\.)?vimeo\.com$/i,
  /^(www\.)?twitch\.tv$/i, /^(www\.)?facebook\.com$/i, /^(www\.)?linkedin\.com$/i,
  /^(www\.)?m\.youtube\.com$/i, /^(www\.)?vm\.tiktok\.com$/i, /^(www\.)?vt\.tiktok\.com$/i,
];

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);
const BLOCKED_IPS = new Set(["169.254.169.254", "100.100.100.200"]);

function isPrivateIp(host: string): boolean {
  if (BLOCKED_HOSTS.has(host) || BLOCKED_IPS.has(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1]), parseInt(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function stripTrackingParams(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function detectPlatform(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const map: Record<string, string> = {
    "youtube.com": "youtube", "youtu.be": "youtube", "tiktok.com": "tiktok",
    "vm.tiktok.com": "tiktok", "vt.tiktok.com": "tiktok", "instagram.com": "instagram",
    "x.com": "x", "twitter.com": "x", "reddit.com": "reddit", "pinterest.com": "pinterest",
    "vimeo.com": "vimeo", "twitch.tv": "twitch", "facebook.com": "facebook", "linkedin.com": "linkedin",
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
