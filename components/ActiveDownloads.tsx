"use client";
import { useState } from "react";
import { Activity, Gauge, Clock, XCircle, Loader2, CheckCircle2, Radio, AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { api, type Job } from "@/lib/api";
import { useStore } from "@/lib/store";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  extracting: "Extracting",
  trimming: "Downloading & FFmpeg",
  transcribing: "Captions & Summary",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

function shortId(id: string) {
  return id.replace(/^ms_/, "").slice(0, 8);
}

export default function ActiveDownloads() {
  const { jobs, wsConnected, upsertJob, removeJob } = useStore();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const visible = jobs.filter((j) => !["ready", "cancelled"].includes(j.status));

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

  async function retry(job: Job) {
    setRetrying(job.id);
    try {
      const fresh = await api.createJob({
        url: job.sanitized_url,
        resolution: job.resolution,
        format: job.format,
        trim_start: job.trim_start,
        trim_end: job.trim_end,
        generate_subtitles: Boolean(job.generate_subtitles),
        generate_summary: Boolean(job.generate_summary),
      });
      removeJob(job.id);
      upsertJob(fresh);
    } catch {
      /* ignore */
    } finally {
      setRetrying(null);
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
          {wsConnected ? "WSS live · 200ms pushes" : "Live HTTP polling · 1.2s"}
        </span>
      </div>

      {visible.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 bg-panel p-10 text-center text-sm text-slate-400">
          No active jobs. Extract a URL to see live progress here.
          <div className="mt-2 text-xs text-slate-500">States: Queued → Extracting → Downloading &amp; FFmpeg → Captions &amp; Summary → Ready</div>
        </div>
      )}

      <div className="space-y-3">
        {visible.map((job) => {
          const isFailed = job.status === "failed";
          return (
            <div
              key={job.id}
              className={`rounded-2xl border p-4 ${
                isFailed ? "border-red-500/30 bg-red-950/15" : "border-white/10 bg-panel"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {isFailed ? (
                      <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                    ) : (
                      <Loader2 className="w-4 h-4 animate-spin text-accent shrink-0" />
                    )}
                    <span className="text-xs font-mono text-slate-500">#{shortId(job.id)}</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-300">{job.platform}</span>
                    <span className={`text-xs ${isFailed ? "text-red-300 font-medium" : "text-slate-400"}`}>
                      {STAGE_LABEL[job.status] ?? job.status}
                    </span>
                  </div>
                  <h3 className="mt-1 truncate text-sm font-semibold text-white">{job.title}</h3>
                  <p className="truncate text-xs text-slate-500">{job.sanitized_url}</p>
                </div>

                {isFailed ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => retry(job)}
                      disabled={retrying === job.id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs text-white hover:bg-accent/25 disabled:opacity-40 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Retry
                    </button>
                    <button
                      onClick={() => removeJob(job.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 transition"
                      title="Dismiss"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => cancel(job.id)}
                    disabled={cancelling === job.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Cancel
                  </button>
                )}
              </div>

              {isFailed ? (
                <div className="mt-3 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {job.error || "Extraction or media conversion failed."}
                </div>
              ) : (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
                    <span>
                      {job.status === "trimming"
                        ? "Downloading source stream & processing via FFmpeg"
                        : job.status === "transcribing"
                          ? "Fetching timed captions & generating summary"
                          : job.status === "extracting"
                            ? "Resolving live metadata & stream URLs"
                            : "Queued for execution"}
                    </span>
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
              )}
            </div>
          );
        })}
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
