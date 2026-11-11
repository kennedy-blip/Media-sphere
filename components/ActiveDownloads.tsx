"use client";
import { useState } from "react";
import { Activity, Gauge, Clock, XCircle, Loader2, CheckCircle2, Radio } from "lucide-react";
import { api, formatBytes } from "@/lib/api";
import { useStore } from "@/lib/store";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  extracting: "Extracting",
  trimming: "Trimming",
  transcribing: "Transcribing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function ActiveDownloads() {
  const { jobs, wsConnected } = useStore();
  const [cancelling, setCancelling] = useState<string | null>(null);

  const active = jobs.filter((j) => !["ready", "failed", "cancelled"].includes(j.status));

  async function cancel(id: string) {
    setCancelling(id);
    try {
      await api.cancelJob(id);
    } catch {
      /* ignore */
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" /> Queue board
        </h2>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
          wsConnected
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-300"
        }`}>
          <Radio className="w-3.5 h-3.5" />
          {wsConnected ? "WSS live · 200ms pushes" : "Polling fallback · 2s"}
        </span>
      </div>

      {active.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 bg-panel p-10 text-center text-sm text-slate-400">
          No active jobs. Extract a URL to see live progress here.
          <div className="mt-2 text-xs text-slate-500">States: Queued → Extracting → Trimming → Transcribing → Ready</div>
        </div>
      )}

      <div className="space-y-3">
        {active.map((job) => (
          <div key={job.id} className="rounded-2xl border border-white/10 bg-panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
                  <span className="text-xs font-mono text-slate-500">#{job.id.slice(0, 6)}</span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-300">{job.platform}</span>
                  <span className="text-xs text-slate-400">{STAGE_LABEL[job.status] ?? job.status}</span>
                </div>
                <h3 className="mt-1 truncate text-sm font-semibold text-white">{job.title}</h3>
                <p className="truncate text-xs text-slate-500">{job.sanitized_url}</p>
              </div>
              <button
                onClick={() => cancel(job.id)}
                disabled={cancelling === job.id}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition"
              >
                <XCircle className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
                <span>{job.status === "trimming" ? "Trimming video via FFmpeg" : job.status === "transcribing" ? "Transcribing with Whisper" : job.status === "extracting" ? "Extracting streams" : "Waiting in queue"}</span>
                <span className="font-mono text-white">{Math.round(job.progress)}%</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-mint transition-all duration-300"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Gauge className="w-3.5 h-3.5" /> {job.speed_mbps.toFixed(1)} MB/s
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> ETA {job.eta_seconds != null ? `${job.eta_seconds}s` : "—"}
                </span>
                <span>{job.resolution} · {job.format.toUpperCase()}</span>
                {(job.trim_start || job.trim_end) && (
                  <span>Trim {job.trim_start ?? "00:00"} → {job.trim_end ?? "end"}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {jobs.some((j) => j.status === "ready") && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          Completed jobs move to the Completed tab automatically.
        </p>
      )}
    </div>
  );
}
