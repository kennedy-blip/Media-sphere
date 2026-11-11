"use client";
import { useState } from "react";
import {
  CheckCircle2, Download, Copy, Check, ChevronDown, ChevronUp,
  FileVideo, FileAudio, CloudUpload, Sparkles, FileText, Scissors,
} from "lucide-react";
import { api, formatBytes, formatDuration } from "@/lib/api";
import { useStore } from "@/lib/store";

function shortId(id: string) {
  return id.replace(/^ms_/, "").slice(0, 8);
}

function safeFileStem(title: string, fallback: string) {
  return (
    title
      .replace(/[^A-Za-z0-9._ -]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60) || fallback
  );
}

export default function CompletedDownloads() {
  const { jobs } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});

  const done = jobs.filter((j) => j.status === "ready");

  async function copyTranscript(jobId: string, text: string | null | undefined) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(jobId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard denied */
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-white flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Completed assets ({done.length})
      </h2>

      {done.length === 0 && (
        <div className="rounded-2xl border border-dashed border-white/10 bg-panel p-10 text-center text-sm text-slate-400">
          Nothing here yet. Finished jobs will appear as cards with live media players and export actions.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {done.map((job) => {
          const isAudio = ["mp3", "wav"].includes(job.format);
          const open = openId === job.id;
          const inlineUrl = api.downloadUrl(job.id, false);
          const saveUrl = api.downloadUrl(job.id, true);
          const hasMediaErr = Boolean(mediaErrors[job.id]);
          const stem = safeFileStem(job.title, shortId(job.id));

          return (
            <article key={job.id} className="overflow-hidden rounded-2xl border border-white/10 bg-panel">
              {job.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={job.thumbnail}
                  alt={job.title}
                  referrerPolicy="no-referrer"
                  className="h-36 w-full object-cover bg-ink"
                />
              ) : (
                <div className="flex h-36 w-full items-center justify-center bg-ink text-slate-500">
                  {isAudio ? <FileAudio className="w-10 h-10" /> : <FileVideo className="w-10 h-10" />}
                </div>
              )}
              <div className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white leading-snug">{job.title}</h3>
                  <span className="shrink-0 font-mono text-[11px] text-slate-500">#{shortId(job.id)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                  {job.creator && <span className="text-slate-200">{job.creator}</span>}
                  <span className="capitalize">{job.platform}</span>
                  <span>{job.resolution} · {job.format.toUpperCase()}</span>
                  <span>{formatDuration(job.duration)}</span>
                  <span>{formatBytes(job.file_size)}</span>
                  {(job.trim_start || job.trim_end) && (
                    <span className="inline-flex items-center gap-1 text-accent">
                      <Scissors className="w-3 h-3" /> {job.trim_start ?? "00:00"}–{job.trim_end ?? "end"}
                    </span>
                  )}
                </div>

                {/* Real HTML5 media player */}
                {job.download_url && !hasMediaErr && (
                  isAudio ? (
                    <audio
                      controls
                      src={inlineUrl}
                      onError={() => setMediaErrors((m) => ({ ...m, [job.id]: true }))}
                      className="w-full"
                    />
                  ) : (
                    <video
                      controls
                      src={inlineUrl}
                      poster={job.thumbnail ?? undefined}
                      preload="metadata"
                      onError={() => setMediaErrors((m) => ({ ...m, [job.id]: true }))}
                      className="w-full rounded-lg bg-ink max-h-52"
                    />
                  )
                )}
                {hasMediaErr && (
                  <div className="flex items-center justify-between rounded-lg border border-white/10 bg-ink px-3 py-2 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      {isAudio ? <FileAudio className="w-4 h-4 text-accent" /> : <FileVideo className="w-4 h-4 text-accent" />}
                      Ready for download ({job.format.toUpperCase()} · {formatBytes(job.file_size)})
                    </span>
                  </div>
                )}

                {/* AI transcript & summary drawer */}
                {(job.transcript || job.summary) && (
                  <div className="rounded-xl border border-white/5 bg-ink">
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : job.id)}
                      className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-slate-200"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-accent" /> Transcript &amp; AI summary
                      </span>
                      {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    {open && (
                      <div className="space-y-2 px-3 pb-3">
                        {job.summary && (
                          <p className="rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-300">
                            <span className="font-semibold text-white">Summary: </span>{job.summary}
                          </p>
                        )}
                        {job.transcript && (
                          <p className="max-h-40 overflow-y-auto rounded-lg bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-300">
                            {job.transcript}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <a
                    href={saveUrl}
                    download={`${stem}.${job.format}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/90 transition"
                  >
                    <Download className="w-3.5 h-3.5" /> Save File
                  </a>
                  <a
                    href="https://drive.google.com/drive/my-drive"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                  >
                    <CloudUpload className="w-3.5 h-3.5" /> Drive
                  </a>
                  <a
                    href="https://www.dropbox.com/home"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                  >
                    <CloudUpload className="w-3.5 h-3.5" /> Dropbox
                  </a>
                  {job.transcript && (
                    <button
                      type="button"
                      onClick={() => copyTranscript(job.id, job.transcript)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      {copiedId === job.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      Copy Transcript
                    </button>
                  )}
                  {job.srt && (
                    <button
                      type="button"
                      onClick={() => {
                        const blob = new Blob([job.srt ?? ""], { type: "text/plain;charset=utf-8" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${stem}.srt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      <FileText className="w-3.5 h-3.5" /> .SRT
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
