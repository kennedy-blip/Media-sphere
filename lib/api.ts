/** API client for MediaSphere FastAPI gateway. */

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
  formats: Array<{ format_id: string; label: string; ext: string; resolution: string; filesize: number | null; fps?: number; abr?: number }>;
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

const BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
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
    url: string; resolution: string; format: string;
    trim_start?: string | null; trim_end?: string | null;
    generate_subtitles: boolean; generate_summary: boolean;
  }) => req<Job>("/api/v1/jobs", { method: "POST", body: JSON.stringify(payload) }),
  createBatch: (payload: {
    urls: string[]; resolution: string; format: string;
    trim_start?: string | null; trim_end?: string | null;
    generate_subtitles: boolean; generate_summary: boolean;
  }) => req<{ jobs: Job[]; errors: Array<{ url: string; error: string }>; created: number }>("/api/v1/batch", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  listJobs: () => req<{ jobs: Job[] }>("/api/v1/jobs"),
  getJob: (id: string) => req<Job>(`/api/v1/jobs/${id}`),
  cancelJob: (id: string) => req<{ cancelled: boolean; id: string }>(`/api/v1/jobs/${id}`, { method: "DELETE" }),
  downloadUrl: (id: string) => `${BASE}/api/v1/jobs/${id}/download`,
};

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
