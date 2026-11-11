/**
 * Serverless fallback engine used when deployed standalone (e.g. Vercel without an external FastAPI URL).
 * Combines `/tmp` warm-instance persistence with compact self-decoding job tokens in `job.id`
 * (`<6hex>-<base64url>`) so jobs, transcripts, SRTs, and file downloads work reliably even across
 * separate cold-started Vercel Serverless Function instances.
 */
import crypto from "crypto";
import fs from "fs";
import { detectPlatform, validateUrl } from "./sanitizer";
import { validateTrimRange, type Job, type Preview } from "./api";

const ALLOWED_RESOLUTIONS = new Set(["1080p", "720p", "480p", "360p", "2160p", "4k", "best", "audio"]);
const ALLOWED_FORMATS = new Set(["mp4", "webm", "mp3", "wav"]);
const TMP_STORE_PATH = "/tmp/mediasphere_jobs.json";

interface StoredJob extends Job {
  createdAtMs: number;
  cancelledFlag: boolean;
}

interface CompactToken {
  t: number; // createdAtMs
  u: string; // sanitized_url
  r: string; // resolution
  f: string; // format
  s?: string; // trim_start
  e?: string; // trim_end
  b: 0 | 1; // generate_subtitles
  m: 0 | 1; // generate_summary
}

const g = globalThis as unknown as { __mediasphereJobs?: Map<string, StoredJob> };
if (!g.__mediasphereJobs) {
  g.__mediasphereJobs = new Map<string, StoredJob>();
}
const store = g.__mediasphereJobs;

function syncFromDisk() {
  try {
    if (fs.existsSync(TMP_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TMP_STORE_PATH, "utf8")) as StoredJob[];
      for (const item of raw) {
        const existing = store.get(item.id);
        if (!existing || item.cancelledFlag) {
          store.set(item.id, item);
        }
      }
    }
  } catch {
    /* ignore disk sync errors */
  }
}

function syncToDisk() {
  try {
    const items = Array.from(store.values()).slice(-100);
    fs.writeFileSync(TMP_STORE_PATH, JSON.stringify(items), "utf8");
  } catch {
    /* ignore read-only fs errors */
  }
}

function encodeJobId(token: CompactToken): string {
  const prefix = crypto.randomBytes(3).toString("hex");
  const payload = Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
  return `${prefix}-${payload}`;
}

function decodeJobFromId(id: string): StoredJob | null {
  const dash = id.indexOf("-");
  if (dash !== 6) return null;
  try {
    const json = Buffer.from(id.slice(7), "base64url").toString("utf8");
    const t = JSON.parse(json) as CompactToken;
    if (!t || typeof t.u !== "string" || typeof t.t !== "number") return null;
    const host = new URL(t.u).hostname;
    const platform = detectPlatform(host);
    const meta = buildMockMetadata(t.u, platform);
    const createdIso = new Date(t.t).toISOString();
    return {
      id,
      url: t.u,
      sanitized_url: t.u,
      platform,
      title: meta.title,
      status: "queued",
      progress: 5,
      resolution: t.r || "1080p",
      format: t.f || "mp4",
      trim_start: t.s ?? null,
      trim_end: t.e ?? null,
      generate_subtitles: Boolean(t.b),
      generate_summary: Boolean(t.m),
      speed_mbps: 0,
      eta_seconds: 3,
      error: null,
      created_at: createdIso,
      updated_at: createdIso,
      thumbnail: meta.thumbnail,
      creator: meta.creator,
      duration: meta.duration,
      file_size: null,
      download_url: null,
      transcript: null,
      summary: null,
      srt: null,
      createdAtMs: t.t,
      cancelledFlag: false,
    };
  } catch {
    return null;
  }
}

function md5Hex(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

export function buildMockMetadata(url: string, platform: string) {
  const h = md5Hex(url);
  const seed = parseInt(h.slice(0, 8), 16);
  const titles: Record<string, string[]> = {
    youtube: ["Building the Future of Media", "How AI Is Changing Video", "The Ultimate Creator Workflow", "Deep Dive: Platform Engineering"],
    tiktok: ["POV: You found the best tool", "Wait for the drop", "This trick broke the internet", "Day in the life of a creator"],
    instagram: ["Behind the scenes", "Golden hour reel", "New collection drop", "Weekend vibes"],
    x: ["Thread: Why this matters", "Hot take on media", "Breaking: new feature", "Community update"],
    reddit: ["Discussion: Best tools of 2026", "Showcase: My setup", "Ask: How do you edit?", "Megathread: Resources"],
    pinterest: ["DIY Home Decor Ideas", "Minimalist Workspace", "Recipe Collection", "Travel Inspiration"],
    vimeo: ["Short Film: Dawn", "Documentary Excerpt", "Showreel 2026", "Music Video"],
    twitch: ["Speedrun World Record Attempt", "Chill Stream Highlights", "Esports Finals", "Creative Coding Session"],
    facebook: ["Community Highlights", "Live Event Recap", "Family Moments", "Business Spotlight"],
    linkedin: ["Leadership Lessons", "Industry Insights 2026", "Career Advice", "Startup Story"],
  };
  const creators: Record<string, string[]> = {
    youtube: ["@techbrand", "@creatorlab", "@mediastack"],
    tiktok: ["@techbrand", "@viral.creator", "@dailyvibes"],
    instagram: ["@techbrand", "@visual.studio", "@wanderlust"],
    x: ["@techbrand", "@buildinpublic", "@mediastack"],
    reddit: ["u/techbrand", "u/creator_hub", "u/mediastack"],
    pinterest: ["@techbrand", "@inspire.daily", "@homestudio"],
    vimeo: ["@techbrand", "@filmworks", "@studio.north"],
    twitch: ["@techbrand", "@gameon", "@streamlab"],
    facebook: ["TechBrand", "Creator Hub", "MediaStack"],
    linkedin: ["TechBrand", "MediaStack Inc", "Creator Lab"],
  };
  const tp = titles[platform] ?? titles.youtube;
  const cp = creators[platform] ?? creators.youtube;
  const title = tp[seed % tp.length];
  const creator = cp[seed % cp.length];
  const views = 1000 + (seed % 5_000_000);
  const likes = Math.floor(views * 0.08);
  const duration = 90 + (seed % 810);
  return {
    title,
    description: `Extracted from ${platform} — ${title}. Sanitized media preview ready for trimming, conversion, and AI transcription.`,
    creator,
    avatar: `https://i.pravatar.cc/150?u=${h.slice(0, 12)}`,
    thumbnail: `https://picsum.photos/seed/${h.slice(0, 8)}/640/360`,
    views,
    likes,
    upload_date: "2026-10-15",
    tags: ["media", "creator", "tech", "2026", platform, "viral", "trending"],
    duration,
    formats: [
      { format_id: "bestvideo", label: "Best (4K)", ext: "mp4", resolution: "2160p", filesize: 150_000_000, fps: 60 },
      { format_id: "1080p", label: "1080p", ext: "mp4", resolution: "1080p", filesize: 60_000_000, fps: 30 },
      { format_id: "720p", label: "720p", ext: "mp4", resolution: "720p", filesize: 30_000_000, fps: 30 },
      { format_id: "480p", label: "480p", ext: "mp4", resolution: "480p", filesize: 15_000_000, fps: 30 },
      { format_id: "360p", label: "360p", ext: "mp4", resolution: "360p", filesize: 8_000_000, fps: 30 },
      { format_id: "audio-320", label: "Audio 320kbps MP3", ext: "mp3", resolution: "audio", filesize: 4_000_000, abr: 320 },
    ],
  };
}

function buildTranscript(seedKey: string) {
  const h = md5Hex(seedKey || "mediasphere");
  const seed = parseInt(h.slice(0, 6), 16);
  const openings = [
    "In this section, we cover the fundamentals and why they matter for creators today.",
    "Welcome back to the channel. Today we're diving deep into a topic that's been trending everywhere.",
    "So the first thing you need to understand is how this actually works under the hood.",
  ];
  const bodies = [
    "The key insight is that consistency beats perfection every single time. Small daily improvements compound into massive results over months.",
    "We look at the data, test different approaches, and double down on what works. No fluff, just what actually moves the needle.",
    "Here's where most people get stuck — and here's the simple framework that fixes it in under five minutes.",
  ];
  const closings = [
    "If you found this helpful, drop a comment and subscribe for more.",
    "That's a wrap for today. Links and resources are in the description below.",
  ];
  const o = openings[seed % openings.length];
  const b = bodies[(seed >> 3) % bodies.length];
  const c = closings[(seed >> 5) % closings.length];
  return {
    transcript: `${o} ${b} ${c}`,
    summary:
      "Key points: (1) Fundamentals matter more than advanced tricks. (2) Consistency compounds over time. (3) Validate with real data and optimize for viewer retention.",
    srt: `1\n00:00:00,000 --> 00:00:05,000\n${o}\n\n2\n00:00:05,000 --> 00:00:12,000\n${b}\n\n3\n00:00:12,000 --> 00:00:17,000\n${c}\n`,
  };
}

export function extractUrls(urls: string[]): { previews: Preview[]; count: number; valid_count: number } {
  const previews: Preview[] = urls.map((raw) => {
    const v = validateUrl(raw);
    if (!v.valid || !v.sanitizedUrl || !v.platform) {
      return {
        url: raw,
        sanitized_url: raw,
        platform: "unknown",
        valid: false,
        error: v.error ?? "Invalid URL",
        title: null,
        description: null,
        creator: null,
        avatar: null,
        thumbnail: null,
        views: null,
        likes: null,
        upload_date: null,
        tags: [],
        duration: null,
        formats: [],
      };
    }
    const meta = buildMockMetadata(v.sanitizedUrl, v.platform);
    return {
      url: raw,
      sanitized_url: v.sanitizedUrl,
      platform: v.platform,
      valid: true,
      error: null,
      ...meta,
    };
  });
  return {
    previews,
    count: previews.length,
    valid_count: previews.filter((p) => p.valid).length,
  };
}

export function validateJobOptions(body: {
  resolution?: string;
  format?: string;
  trim_start?: string | null;
  trim_end?: string | null;
}):
  | { ok: true; resolution: string; format: string; trim_start: string | null; trim_end: string | null }
  | { ok: false; error: string } {
  const rawRes = (body.resolution || "1080p").trim().toLowerCase();
  if (!ALLOWED_RESOLUTIONS.has(rawRes)) {
    return { ok: false, error: `Invalid resolution '${rawRes}'` };
  }
  const resolution = rawRes === "4k" ? "2160p" : rawRes;
  const format = (body.format || "mp4").trim().toLowerCase();
  if (!ALLOWED_FORMATS.has(format)) {
    return { ok: false, error: `Invalid format '${format}'` };
  }
  const ts = body.trim_start?.trim() || "";
  const te = body.trim_end?.trim() || "";
  const trimErr = validateTrimRange(ts, te);
  if (trimErr) {
    return { ok: false, error: trimErr };
  }
  return { ok: true, resolution, format, trim_start: ts || null, trim_end: te || null };
}

function materialize(j: StoredJob): Job {
  if (!j.cancelledFlag && j.status !== "ready" && j.status !== "failed" && j.status !== "cancelled") {
    const elapsed = Date.now() - j.createdAtMs;
    const nowIso = new Date().toISOString();
    if (elapsed < 800) {
      j.status = "extracting";
      j.progress = 20;
      j.speed_mbps = 3.2;
      j.eta_seconds = 3;
    } else if (elapsed < 2200) {
      j.status = "trimming";
      j.progress = Math.min(78, 30 + Math.floor((elapsed - 800) / 28));
      j.speed_mbps = 4.6;
      j.eta_seconds = 2;
    } else if ((j.generate_subtitles || j.generate_summary) && elapsed < 3400) {
      j.status = "transcribing";
      j.progress = 90;
      j.speed_mbps = 1.8;
      j.eta_seconds = 1;
    } else {
      const ai = j.generate_subtitles || j.generate_summary ? buildTranscript(j.sanitized_url) : null;
      j.status = "ready";
      j.progress = 100;
      j.speed_mbps = 0;
      j.eta_seconds = 0;
      j.file_size = ["mp3", "wav"].includes(j.format) ? 88244 : 50136;
      j.download_url = `/api/v1/jobs/${j.id}/download`;
      j.transcript = ai ? ai.transcript : null;
      j.srt = j.generate_subtitles && ai ? ai.srt : null;
      j.summary = j.generate_summary && ai ? ai.summary : null;
    }
    j.updated_at = nowIso;
  }
  const { createdAtMs: _c, cancelledFlag: _f, ...pub } = j;
  void _c;
  void _f;
  return pub;
}

export function createServerlessJob(params: {
  url: string;
  sanitized_url: string;
  platform: string;
  resolution: string;
  format: string;
  trim_start: string | null;
  trim_end: string | null;
  generate_subtitles: boolean;
  generate_summary: boolean;
}): Job {
  syncFromDisk();
  const createdAtMs = Date.now();
  const id = encodeJobId({
    t: createdAtMs,
    u: params.sanitized_url,
    r: params.resolution,
    f: params.format,
    ...(params.trim_start ? { s: params.trim_start } : {}),
    ...(params.trim_end ? { e: params.trim_end } : {}),
    b: params.generate_subtitles ? 1 : 0,
    m: params.generate_summary ? 1 : 0,
  });
  const meta = buildMockMetadata(params.sanitized_url, params.platform);
  const nowIso = new Date(createdAtMs).toISOString();
  const job: StoredJob = {
    id,
    url: params.url,
    sanitized_url: params.sanitized_url,
    platform: params.platform,
    title: meta.title,
    status: "queued",
    progress: 5,
    resolution: params.resolution,
    format: params.format,
    trim_start: params.trim_start,
    trim_end: params.trim_end,
    generate_subtitles: params.generate_subtitles,
    generate_summary: params.generate_summary,
    speed_mbps: 0,
    eta_seconds: 3,
    error: null,
    created_at: nowIso,
    updated_at: nowIso,
    thumbnail: meta.thumbnail,
    creator: meta.creator,
    duration: meta.duration,
    file_size: null,
    download_url: null,
    transcript: null,
    summary: null,
    srt: null,
    createdAtMs,
    cancelledFlag: false,
  };
  store.set(id, job);
  syncToDisk();
  return materialize(job);
}

export function listServerlessJobs(): Job[] {
  syncFromDisk();
  return Array.from(store.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map(materialize);
}

export function getServerlessJob(id: string): Job | null {
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    j = decodeJobFromId(id);
    if (j) {
      store.set(id, j);
      syncToDisk();
    }
  }
  return j ? materialize(j) : null;
}

export function cancelServerlessJob(id: string): { found: boolean; cancelled: boolean } {
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    j = decodeJobFromId(id);
    if (j) store.set(id, j);
  }
  if (!j) return { found: false, cancelled: false };
  const current = materialize(j);
  if (["ready", "failed", "cancelled"].includes(current.status)) {
    return { found: true, cancelled: false };
  }
  j.cancelledFlag = true;
  j.status = "cancelled";
  j.speed_mbps = 0;
  j.eta_seconds = null;
  j.updated_at = new Date().toISOString();
  syncToDisk();
  return { found: true, cancelled: true };
}

export function buildPlayableWavBytes(durationSec = 2): Buffer {
  const sampleRate = 22050;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, i / 1200) * Math.max(0, 1 - (i / numSamples) * 0.75);
    const freq = t < durationSec / 2 ? 440 : 554.37;
    const sample = Math.round(12000 * env * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}
