/**
 * Real-world serverless job engine for Next.js App Router & Vercel Fluid Compute.
 * Uses real multi-platform metadata extraction, real stream downloading,
 * real @ffmpeg-installer/ffmpeg trimming/conversion, and real caption/SRT extraction.
 */
import crypto from "crypto";
import fs from "fs";
import { detectPlatform, validateUrl } from "./sanitizer";
import { validateTrimRange, type Job, type Preview } from "./api";
import { extractRealMetadata, type ExtractedMetadata } from "./realExtractor";
import { downloadAndProcessRealMedia, getCachedMediaPath } from "./realProcessor";
import { extractRealTranscriptAndSummary } from "./realTranscriber";

const ALLOWED_RESOLUTIONS = new Set(["1080p", "720p", "480p", "360p", "2160p", "4k", "best", "audio"]);
const ALLOWED_FORMATS = new Set(["mp4", "webm", "mp3", "wav"]);
const TMP_STORE_PATH = "/tmp/mediasphere_jobs_v2.json";

interface StoredJob extends Job {
  createdAtMs: number;
  cancelledFlag: boolean;
  fileKey: string;
}

export interface CompactToken {
  t: number;  // createdAtMs
  u: string;  // sanitized_url
  r: string;  // resolution
  f: string;  // format
  s?: string; // trim_start
  e?: string; // trim_end
  b: 0 | 1;   // generate_subtitles
  m: 0 | 1;   // generate_summary
}

const g = globalThis as unknown as {
  __mediasphereRealJobs?: Map<string, StoredJob>;
  __mediasphereRunningJobs?: Set<string>;
};
if (!g.__mediasphereRealJobs) g.__mediasphereRealJobs = new Map<string, StoredJob>();
if (!g.__mediasphereRunningJobs) g.__mediasphereRunningJobs = new Set<string>();

const store = g.__mediasphereRealJobs;
const running = g.__mediasphereRunningJobs;

export function computeFileKey(params: {
  url: string;
  resolution: string;
  format: string;
  trimStart: string | null;
  trimEnd: string | null;
}): string {
  return crypto
    .createHash("md5")
    .update(`${params.url}|${params.resolution}|${params.format}|${params.trimStart || ""}|${params.trimEnd || ""}`)
    .digest("hex")
    .slice(0, 16);
}

function syncFromDisk() {
  try {
    if (fs.existsSync(TMP_STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TMP_STORE_PATH, "utf8")) as StoredJob[];
      for (const item of raw) {
        const cur = store.get(item.id);
        if (
          !cur ||
          item.updated_at > cur.updated_at ||
          item.status === "ready" ||
          item.status === "failed" ||
          item.cancelledFlag
        ) {
          store.set(item.id, item);
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function syncToDisk() {
  try {
    const items = Array.from(store.values()).slice(-80);
    fs.writeFileSync(TMP_STORE_PATH, JSON.stringify(items), "utf8");
  } catch {
    /* ignore */
  }
}

function encodeJobId(token: CompactToken): string {
  const prefix = crypto.randomBytes(3).toString("hex");
  const payload = Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
  return `${prefix}-${payload}`;
}

export function decodeTokenFromId(id: string): CompactToken | null {
  const dash = id.indexOf("-");
  if (dash !== 6) return null;
  try {
    const json = Buffer.from(id.slice(7), "base64url").toString("utf8");
    const t = JSON.parse(json) as CompactToken;
    if (!t || typeof t.u !== "string" || typeof t.t !== "number") return null;
    return t;
  } catch {
    return null;
  }
}

function reconstructJobFromToken(id: string, t: CompactToken): StoredJob {
  const host = new URL(t.u).hostname;
  const platform = detectPlatform(host);
  const createdIso = new Date(t.t).toISOString();
  const fileKey = computeFileKey({
    url: t.u,
    resolution: t.r || "1080p",
    format: t.f || "mp4",
    trimStart: t.s ?? null,
    trimEnd: t.e ?? null,
  });
  return {
    id,
    url: t.u,
    sanitized_url: t.u,
    platform,
    title: "Extracting real metadata…",
    status: "queued",
    progress: 5,
    resolution: t.r || "1080p",
    format: t.f || "mp4",
    trim_start: t.s ?? null,
    trim_end: t.e ?? null,
    generate_subtitles: Boolean(t.b),
    generate_summary: Boolean(t.m),
    speed_mbps: 0,
    eta_seconds: null,
    error: null,
    created_at: createdIso,
    updated_at: createdIso,
    thumbnail: null,
    creator: null,
    duration: null,
    file_size: null,
    download_url: null,
    transcript: null,
    summary: null,
    srt: null,
    createdAtMs: t.t,
    cancelledFlag: false,
    fileKey,
  };
}

function toPublicJob(j: StoredJob): Job {
  const { createdAtMs: _c, cancelledFlag: _f, fileKey: _k, ...pub } = j;
  void _c;
  void _f;
  void _k;
  return pub;
}

function updateStoredJob(id: string, patch: Partial<StoredJob>): StoredJob | null {
  const cur = store.get(id);
  if (!cur) return null;
  if (cur.cancelledFlag && patch.status !== "cancelled") return cur;
  Object.assign(cur, patch, { updated_at: new Date().toISOString() });
  store.set(id, cur);
  syncToDisk();
  return cur;
}

export async function extractUrlsReal(urls: string[]): Promise<{
  previews: Preview[];
  count: number;
  valid_count: number;
}> {
  const previews = await Promise.all(
    urls.map(async (raw): Promise<Preview> => {
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
      try {
        const meta = await extractRealMetadata(v.sanitizedUrl, v.platform);
        return {
          url: raw,
          sanitized_url: v.sanitizedUrl,
          platform: v.platform,
          valid: true,
          error: null,
          ...meta,
        };
      } catch (err) {
        return {
          url: raw,
          sanitized_url: v.sanitizedUrl,
          platform: v.platform,
          valid: false,
          error: err instanceof Error ? err.message : "Failed to extract live metadata from source",
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
    })
  );

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
  const fileKey = computeFileKey({
    url: params.sanitized_url,
    resolution: params.resolution,
    format: params.format,
    trimStart: params.trim_start,
    trimEnd: params.trim_end,
  });
  const nowIso = new Date(createdAtMs).toISOString();
  const job: StoredJob = {
    id,
    url: params.url,
    sanitized_url: params.sanitized_url,
    platform: params.platform,
    title: "Extracting live stream…",
    status: "extracting",
    progress: 8,
    resolution: params.resolution,
    format: params.format,
    trim_start: params.trim_start,
    trim_end: params.trim_end,
    generate_subtitles: params.generate_subtitles,
    generate_summary: params.generate_summary,
    speed_mbps: 0,
    eta_seconds: null,
    error: null,
    created_at: nowIso,
    updated_at: nowIso,
    thumbnail: null,
    creator: null,
    duration: null,
    file_size: null,
    download_url: null,
    transcript: null,
    summary: null,
    srt: null,
    createdAtMs,
    cancelledFlag: false,
    fileKey,
  };
  store.set(id, job);
  syncToDisk();
  return toPublicJob(job);
}

export async function runRealServerlessJob(id: string): Promise<void> {
  if (running.has(id)) return;
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    const token = decodeTokenFromId(id);
    if (!token) return;
    j = reconstructJobFromToken(id, token);
    store.set(id, j);
    syncToDisk();
  }
  if (j.status === "ready" || j.status === "cancelled" || j.cancelledFlag) return;

  running.add(id);
  try {
    updateStoredJob(id, { status: "extracting", progress: 12 });
    const meta: ExtractedMetadata = await extractRealMetadata(j.sanitized_url, j.platform);

    syncFromDisk();
    if (store.get(id)?.cancelledFlag) return;

    updateStoredJob(id, {
      title: meta.title,
      thumbnail: meta.thumbnail,
      creator: meta.creator,
      duration: meta.duration,
      status: "trimming",
      progress: 24,
      eta_seconds: 6,
    });

    const mediaResult = await downloadAndProcessRealMedia({
      fileKey: j.fileKey,
      url: j.sanitized_url,
      platform: j.platform,
      resolution: j.resolution,
      format: j.format,
      trimStart: j.trim_start,
      trimEnd: j.trim_end,
      onProgress: (p) => {
        updateStoredJob(id, {
          status: "trimming",
          progress: p.progress,
          speed_mbps: p.speedMbps,
          eta_seconds: p.etaSeconds,
        });
      },
    });

    syncFromDisk();
    if (store.get(id)?.cancelledFlag) return;

    let transcript: string | null = null;
    let srt: string | null = null;
    let summary: string | null = null;

    if (j.generate_subtitles || j.generate_summary) {
      updateStoredJob(id, { status: "transcribing", progress: 86, speed_mbps: 0, eta_seconds: 2 });
      const ai = await extractRealTranscriptAndSummary({
        url: j.sanitized_url,
        platform: j.platform,
        meta,
        trimStart: j.trim_start,
        trimEnd: j.trim_end,
        wantSubtitles: Boolean(j.generate_subtitles),
        wantSummary: Boolean(j.generate_summary),
      });
      transcript = ai.transcript;
      srt = ai.srt;
      summary = ai.summary;
    }

    updateStoredJob(id, {
      status: "ready",
      progress: 100,
      speed_mbps: 0,
      eta_seconds: 0,
      file_size: mediaResult.fileSize,
      download_url: `/api/v1/jobs/${id}/download`,
      transcript,
      srt,
      summary,
    });
  } catch (err) {
    updateStoredJob(id, {
      status: "failed",
      error: err instanceof Error ? err.message : "Media processing failed",
      speed_mbps: 0,
      eta_seconds: null,
    });
  } finally {
    running.delete(id);
  }
}

export function listServerlessJobs(): Job[] {
  syncFromDisk();
  return Array.from(store.values())
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .map(toPublicJob);
}

export function getServerlessJob(id: string): { job: Job | null; needsRun: boolean } {
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    const token = decodeTokenFromId(id);
    if (token) {
      j = reconstructJobFromToken(id, token);
      // Check if media file already exists on this instance
      const cached = getCachedMediaPath(j.fileKey, j.format);
      if (cached && fs.existsSync(cached)) {
        j.status = "ready";
        j.progress = 100;
        j.file_size = fs.statSync(cached).size;
        j.download_url = `/api/v1/jobs/${id}/download`;
      }
      store.set(id, j);
      syncToDisk();
    }
  }
  if (!j) return { job: null, needsRun: false };
  const needsRun =
    !running.has(id) &&
    !j.cancelledFlag &&
    !["ready", "failed", "cancelled"].includes(j.status);
  return { job: toPublicJob(j), needsRun };
}

export async function ensureDownloadableFile(id: string): Promise<{
  filePath: string;
  filename: string;
  format: string;
} | null> {
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    const token = decodeTokenFromId(id);
    if (!token) return null;
    j = reconstructJobFromToken(id, token);
    store.set(id, j);
  }

  let cached = getCachedMediaPath(j.fileKey, j.format);
  if (!cached) {
    // Cold Lambda instance fallback: materialize the real media file on demand
    if (!j.title || j.title.startsWith("Extracting")) {
      try {
        const meta = await extractRealMetadata(j.sanitized_url, j.platform);
        j.title = meta.title;
      } catch {
        j.title = `media_${id.slice(0, 6)}`;
      }
    }
    const built = await downloadAndProcessRealMedia({
      fileKey: j.fileKey,
      url: j.sanitized_url,
      platform: j.platform,
      resolution: j.resolution,
      format: j.format,
      trimStart: j.trim_start,
      trimEnd: j.trim_end,
    });
    cached = built.filePath;
    updateStoredJob(id, {
      status: "ready",
      progress: 100,
      file_size: built.fileSize,
      download_url: `/api/v1/jobs/${id}/download`,
    });
  }

  const ext = j.format || "mp4";
  const safeStem = (j.title || id.slice(0, 6))
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60) || id.slice(0, 6);

  return {
    filePath: cached,
    filename: `${safeStem}.${ext}`,
    format: ext,
  };
}

export function cancelServerlessJob(id: string): { found: boolean; cancelled: boolean } {
  syncFromDisk();
  let j = store.get(id) ?? null;
  if (!j) {
    const token = decodeTokenFromId(id);
    if (token) {
      j = reconstructJobFromToken(id, token);
      store.set(id, j);
    }
  }
  if (!j) return { found: false, cancelled: false };
  if (["ready", "failed", "cancelled"].includes(j.status)) {
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
