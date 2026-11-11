/** API client for MediaSphere gateway. */

export interface Preview {
  url: string;
  sanitized_url: string;
  platform: string;
  valid: boolean;
  error: string | null;
  title: string | null;
  description: string | null;
  creator: string | null;
  avatar: string | null;
  thumbnail: string | null;
  views: number | null;
  likes: number | null;
  upload_date: string | null;
  tags: string[];
  duration: number | null;
  formats: Array<{
    format_id: string;
    label: string;
    ext: string;
    resolution: string;
    filesize: number | null;
    fps?: number;
    abr?: number;
  }>;
}

export interface Job {
  id: string;
  url: string;
  sanitized_url: string;
  platform: string;
  title: string;
  status: "queued" | "extracting" | "trimming" | "transcribing" | "ready" | "failed" | "cancelled";
  progress: number;
  resolution: string;
  format: string;
  trim_start: string | null;
  trim_end: string | null;
  generate_subtitles?: boolean;
  generate_summary?: boolean;
  speed_mbps: number;
  eta_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  thumbnail: string | null;
  creator: string | null;
  duration: number | null;
  file_size: number | null;
  download_url: string | null;
  transcript?: string | null;
  summary?: string | null;
  srt?: string | null;
}

/**
 * Resolve browser-safe API base URL.
 * Never let remote browsers call localhost/127.0.0.1 directly; use Next.js rewrites/routes instead.
 */
export function getBrowserApiBase(): string {
  const configured = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  if (!configured) return "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured)) {
    return "";
  }
  return configured;
}

const BASE = getBrowserApiBase();

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text || res.statusText;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.detail === "string") detail = parsed.detail;
      else if (Array.isArray(parsed.detail) && parsed.detail[0]?.msg) detail = parsed.detail[0].msg;
    } catch {
      /* keep raw text */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  extract: (urls: string[]) =>
    req<{ previews: Preview[]; count: number; valid_count: number }>("/api/v1/extract", {
      method: "POST",
      body: JSON.stringify({ urls }),
    }),
  createJob: (payload: {
    url: string;
    resolution: string;
    format: string;
    trim_start?: string | null;
    trim_end?: string | null;
    generate_subtitles: boolean;
    generate_summary: boolean;
  }) => req<Job>("/api/v1/jobs", { method: "POST", body: JSON.stringify(payload) }),
  createBatch: (payload: {
    urls: string[];
    resolution: string;
    format: string;
    trim_start?: string | null;
    trim_end?: string | null;
    generate_subtitles: boolean;
    generate_summary: boolean;
  }) =>
    req<{ jobs: Job[]; errors: Array<{ url: string; error: string }>; created: number }>(
      "/api/v1/batch",
      { method: "POST", body: JSON.stringify(payload) }
    ),
  listJobs: () => req<{ jobs: Job[] }>("/api/v1/jobs"),
  getJob: (id: string) => req<Job>(`/api/v1/jobs/${id}`),
  cancelJob: (id: string) =>
    req<{ cancelled: boolean; id: string }>(`/api/v1/jobs/${id}`, { method: "DELETE" }),
  downloadUrl: (id: string, asAttachment = false) =>
    `${BASE}/api/v1/jobs/${id}/download${asAttachment ? "?download=true" : ""}`,
};

const TIMESTAMP_RE = /^(?:\d{1,2}:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$/;

export function parseTimestampSeconds(ts: string): number | null {
  const s = ts.trim();
  if (!s) return null;
  if (!TIMESTAMP_RE.test(s)) return NaN;
  const parts = s.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
}

export function validateTrimRange(start: string, end: string): string | null {
  const s = parseTimestampSeconds(start);
  const e = parseTimestampSeconds(end);
  if (s !== null && Number.isNaN(s)) return "Start time must be MM:SS or HH:MM:SS (e.g. 01:15)";
  if (e !== null && Number.isNaN(e)) return "End time must be MM:SS or HH:MM:SS (e.g. 02:30)";
  if (s !== null && e !== null && e <= s) return "End time must be greater than start time";
  return null;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
