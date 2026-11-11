"use client";
import { useState } from "react";
import {
  CheckCircle2, Download, Copy, Check, ChevronDown, ChevronUp,
  FileVideo, FileAudio, CloudUpload, Sparkles, FileText,
} from "lucide-react";
import { api, formatBytes, formatDuration } from "@/lib/api";
import { useStore } from "@/lib/store";

export default function CompletedDownloads() {
  const { jobs } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
          Nothing here yet. Finished jobs will appear as cards with players and export actions.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {done.map((job) => {
          const isAudio = ["mp3", "wav"].includes(job.format);
          const open = openId === job.id;
          return (
            <article key={job.id} className="overflow-hidden rounded-2xl border border-white/10 bg-panel">
              {job.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={job.thumbnail} alt={job.title} className="h-36 w-full object-cover" />
              ) : (
                <div className="flex h-36 w-full items-center justify-center bg-ink text-slate-500">
                  {isAudio ? <FileAudio className="w-10 h-10" /> : <FileVideo className="w-10 h-10" />}
                </div>
              )}
              <div className="p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white leading-snug">{job.title}</h3>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                  <span className="capitalize">{job.platform}</span>
                  <span>{job.resolution} · {job.format.toUpperCase()}</span>
                  <span>{formatDuration(job.duration)}</span>
                  <span>{formatBytes(job.file_size)}</span>
                </div>

                {/* HTML5 preview */}
                {job.download_url && (
                  isAudio ? (
                    <audio controls src={job.download_url} className="w-full" />
                  ) : (
                    <video controls src={job.download_url} className="w-full rounded-lg" preload="metadata" />
                  )
                )}

                {/* AI transcript drawer */}
                {(job.transcript || job.summary) && (
                  <div className="rounded-xl border border-white/5 bg-ink">
                    <button
                      onClick={() => setOpenId(open ? null : job.id)}
                      className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-slate-200"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-accent" /> AI transcript &amp; summary
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
                    href={job.download_url ?? "#"}
                    download
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/90 transition"
                  >
                    <Download className="w-3.5 h-3.5" /> Save File
                  </a>
                  <a
                    href={`https://drive.google.com/drive/my-drive`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                  >
                    <CloudUpload className="w-3.5 h-3.5" /> Drive / Dropbox
                  </a>
                  {job.transcript && (
                    <button
                      onClick={() => copyTranscript(job.id, job.transcript)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      {copiedId === job.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      Copy Transcript
                    </button>
                  )}
                  {job.srt && (
                    <button
                      onClick={() => {
                        const blob = new Blob([job.srt ?? ""], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${job.id}.srt`;
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
