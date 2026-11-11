"use client";
import { useMemo, useState } from "react";
import {
  ClipboardPaste, Link2, ShieldCheck, ShieldAlert, Sparkles, Scissors,
  FileVideo, FileAudio, Layers, Loader2, Plus, X, CheckCircle2, AlertCircle, Wand2, ThumbsUp, Calendar,
} from "lucide-react";
import { api, formatCount, formatDuration, validateTrimRange, type Preview } from "@/lib/api";
import { validateUrl, parseBatchInput } from "@/lib/sanitizer";
import { useStore } from "@/lib/store";

const RESOLUTIONS = ["2160p", "1080p", "720p", "480p", "360p", "best", "audio"];
const FORMATS = ["mp4", "webm", "mp3", "wav"] as const;

const SAMPLE_URLS = [
  "https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0",
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ&utm_source=twitter",
  "https://vimeo.com/76979871",
].join("\n");

const PLATFORM_COLORS: Record<string, string> = {
  youtube: "bg-red-500/15 text-red-300 border-red-500/30",
  tiktok: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  instagram: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  x: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  reddit: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  pinterest: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  vimeo: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  twitch: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  facebook: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  linkedin: "bg-blue-700/15 text-blue-300 border-blue-700/30",
};

interface CardSelection {
  resolution: string;
  format: string;
  trimStart: string;
  trimEnd: string;
  subtitles: boolean;
  summary: boolean;
}

const DEFAULT_SELECTION: CardSelection = {
  resolution: "720p",
  format: "mp4",
  trimStart: "",
  trimEnd: "",
  subtitles: true,
  summary: true,
};

export default function ExtractionWorkspace() {
  const { previews, setPreviews, upsertJob, setTab, setBatchOpen } = useStore();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, CardSelection>>({});

  const urls = useMemo(() => parseBatchInput(input), [input]);
  const validation = useMemo(() => {
    if (!input.trim()) return null;
    return urls.map((u) => ({ url: u, ...validateUrl(u) }));
  }, [input, urls]);

  const validCount = validation ? validation.filter((v) => v.valid).length : 0;

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setInput((prev) => (prev ? prev + "\n" + text : text));
    } catch {
      setError("Clipboard access denied — paste manually with Ctrl+V / Cmd+V");
    }
  }

  function loadDemoBatch() {
    setInput(SAMPLE_URLS);
    setError(null);
  }

  async function handleExtract() {
    if (!urls.length) return;
    if (urls.length > 20) {
      setError("Maximum 20 URLs per batch");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.extract(urls);
      setPreviews(data.previews);
      const init: Record<string, CardSelection> = {};
      data.previews.forEach((p) => {
        const availableRes = p.formats?.map((f) => f.resolution).filter(Boolean) ?? [];
        const preferred =
          availableRes.includes("720p")
            ? "720p"
            : availableRes.includes("1080p")
              ? "1080p"
              : availableRes[0] || "720p";
        init[p.sanitized_url] = { ...DEFAULT_SELECTION, resolution: preferred };
      });
      setSelections(init);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed");
    } finally {
      setLoading(false);
    }
  }

  async function dispatchJob(preview: Preview) {
    const sel = selections[preview.sanitized_url] ?? DEFAULT_SELECTION;
    const trimErr = validateTrimRange(sel.trimStart, sel.trimEnd);
    if (trimErr) {
      setError(trimErr);
      return;
    }
    setError(null);
    setDispatching(true);
    try {
      const job = await api.createJob({
        url: preview.sanitized_url,
        resolution: sel.resolution,
        format: sel.format,
        trim_start: sel.trimStart.trim() || null,
        trim_end: sel.trimEnd.trim() || null,
        generate_subtitles: sel.subtitles,
        generate_summary: sel.summary,
      });
      upsertJob(job);
      setTab("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to dispatch job");
    } finally {
      setDispatching(false);
    }
  }

  async function dispatchAll() {
    const valid = previews.filter((p) => p.valid);
    if (!valid.length) return;
    for (const p of valid) {
      const sel = selections[p.sanitized_url] ?? DEFAULT_SELECTION;
      const trimErr = validateTrimRange(sel.trimStart, sel.trimEnd);
      if (trimErr) {
        setError(`${p.title ?? p.platform}: ${trimErr}`);
        return;
      }
    }
    setError(null);
    setDispatching(true);
    try {
      const created = await Promise.all(
        valid.map((p) => {
          const sel = selections[p.sanitized_url] ?? DEFAULT_SELECTION;
          return api.createJob({
            url: p.sanitized_url,
            resolution: sel.resolution,
            format: sel.format,
            trim_start: sel.trimStart.trim() || null,
            trim_end: sel.trimEnd.trim() || null,
            generate_subtitles: sel.subtitles,
            generate_summary: sel.summary,
          });
        })
      );
      created.forEach((j) => upsertJob(j));
      setTab("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch dispatch failed");
    } finally {
      setDispatching(false);
    }
  }

  function updateSel(key: string, patch: Partial<CardSelection>) {
    setSelections((s) => ({
      ...s,
      [key]: { ...(s[key] ?? DEFAULT_SELECTION), ...patch },
    }));
  }

  return (
    <div className="space-y-6">
      {/* Paste bar */}
      <div className="rounded-2xl border border-white/10 bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Link2 className="w-4 h-4 text-accent" /> Paste media URLs
          </h2>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={loadDemoBatch}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition"
            >
              <Wand2 className="w-3.5 h-3.5" /> Load live sample URLs
            </button>
            <span className="text-xs text-slate-400">Tracking &amp; Mix params auto-stripped · SSRF sandbox active</span>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0\nhttps://www.tiktok.com/@creator/video/...\nhttps://vimeo.com/76979871"}
            rows={4}
            className="flex-1 rounded-xl bg-ink border border-white/10 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-accent/60 resize-y"
          />
          <div className="flex sm:flex-col gap-2">
            <button
              type="button"
              onClick={pasteFromClipboard}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-slate-200 transition"
            >
              <ClipboardPaste className="w-4 h-4" /> Auto-paste
            </button>
            <button
              type="button"
              onClick={() => setBatchOpen(true)}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-slate-200 transition"
            >
              <Plus className="w-4 h-4" /> Batch drawer
            </button>
          </div>
        </div>

        {/* Validation badges */}
        {validation && validation.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {validation.map((v, i) => (
              <span
                key={i}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  v.valid
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-red-500/30 bg-red-500/10 text-red-300"
                }`}
                title={v.valid ? v.sanitizedUrl ?? "" : v.error ?? ""}
              >
                {v.valid ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                {v.platform ?? "invalid"} {v.valid ? `· ${v.sanitizedUrl}` : `· ${v.error}`}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleExtract}
            disabled={loading || !urls.length}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40 transition"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
            {loading ? "Extracting live metadata…" : "Extract metadata"}
          </button>
          <span className="text-xs text-slate-400">
            {urls.length} URL{urls.length !== 1 ? "s" : ""} · {validCount} valid · max 20 per batch
          </span>
        </div>
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
      </div>

      {/* Preview grid */}
      {previews.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">
              Live preview cards ({previews.filter((p) => p.valid).length}/{previews.length} resolved)
            </h3>
            {previews.some((p) => p.valid) && (
              <button
                type="button"
                onClick={dispatchAll}
                disabled={dispatching}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 hover:bg-accent/25 border border-accent/40 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 transition"
              >
                {dispatching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Dispatch all valid ({previews.filter((p) => p.valid).length})
              </button>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {previews.map((p, i) => {
              const sel = selections[p.sanitized_url] ?? DEFAULT_SELECTION;
              const trimErr = validateTrimRange(sel.trimStart, sel.trimEnd);
              return (
                <article key={`${p.sanitized_url}-${i}`} className="overflow-hidden rounded-2xl border border-white/10 bg-panel">
                  {p.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnail}
                      alt={p.title ?? "thumbnail"}
                      referrerPolicy="no-referrer"
                      className="h-44 w-full object-cover bg-ink"
                    />
                  ) : (
                    <div className="flex h-44 w-full items-center justify-center bg-ink text-slate-500 text-sm">
                      {p.valid ? "No thumbnail" : "Extraction failed"}
                    </div>
                  )}
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-semibold text-white leading-snug">{p.title ?? "Unable to extract URL"}</h4>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] capitalize ${PLATFORM_COLORS[p.platform] ?? "bg-white/5 text-slate-300 border-white/10"}`}>
                        {p.platform}
                      </span>
                    </div>
                    {p.description && (
                      <p className="text-xs text-slate-400 line-clamp-2">{p.description}</p>
                    )}
                    {p.valid && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
                          {p.avatar && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.avatar} alt="" referrerPolicy="no-referrer" className="h-4 w-4 rounded-full object-cover" />
                          )}
                          {p.creator ?? "—"}
                        </span>
                        {p.views != null && <span>{formatCount(p.views)} views</span>}
                        {p.likes != null && (
                          <span className="inline-flex items-center gap-1">
                            <ThumbsUp className="w-3 h-3" /> {formatCount(p.likes)}
                          </span>
                        )}
                        {p.duration != null && <span>{formatDuration(p.duration)}</span>}
                        {p.upload_date && (
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> {p.upload_date}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="truncate text-[11px] text-slate-500" title={p.sanitized_url}>{p.sanitized_url}</p>

                    {p.valid && (
                      <div className="space-y-3 border-t border-white/5 pt-3">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-400">
                            Resolution
                            <select
                              value={sel.resolution}
                              onChange={(e) => {
                                const res = e.target.value;
                                const nextFmt = res === "audio" && !["mp3", "wav"].includes(sel.format) ? "mp3" : sel.format;
                                updateSel(p.sanitized_url, { resolution: res, format: nextFmt });
                              }}
                              className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            >
                              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r === "2160p" ? "4K (2160p)" : r}</option>)}
                            </select>
                          </label>
                          <label className="text-xs text-slate-400">
                            Format
                            <select
                              value={sel.format}
                              onChange={(e) => updateSel(p.sanitized_url, { format: e.target.value })}
                              className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            >
                              {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                            </select>
                          </label>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-400">
                            <span className="inline-flex items-center gap-1"><Scissors className="w-3 h-3" /> Trim start</span>
                            <input
                              value={sel.trimStart}
                              onChange={(e) => updateSel(p.sanitized_url, { trimStart: e.target.value })}
                              placeholder="00:10"
                              className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            />
                          </label>
                          <label className="text-xs text-slate-400">
                            <span className="inline-flex items-center gap-1"><Scissors className="w-3 h-3" /> Trim end</span>
                            <input
                              value={sel.trimEnd}
                              onChange={(e) => updateSel(p.sanitized_url, { trimEnd: e.target.value })}
                              placeholder="00:45"
                              className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            />
                          </label>
                        </div>
                        {trimErr && (
                          <p className="text-[11px] text-red-300">{trimErr}</p>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-300">
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={sel.subtitles}
                              onChange={(e) => updateSel(p.sanitized_url, { subtitles: e.target.checked })}
                              className="rounded accent-violet-500"
                            />
                            <Sparkles className="w-3.5 h-3.5 text-accent" /> Subtitles (.SRT)
                          </label>
                          <label className="inline-flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={sel.summary}
                              onChange={(e) => updateSel(p.sanitized_url, { summary: e.target.checked })}
                              className="rounded accent-violet-500"
                            />
                            AI Summary
                          </label>
                        </div>
                        <button
                          type="button"
                          onClick={() => dispatchJob(p)}
                          disabled={dispatching || Boolean(trimErr)}
                          className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40 transition"
                        >
                          {dispatching ? "Dispatching…" : "Extract & process"}
                        </button>
                      </div>
                    )}
                    {!p.valid && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                        <X className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{p.error}</span>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {/* Format legend */}
      <div className="flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><FileVideo className="w-3.5 h-3.5" /> Video: 4K / 1080p / 720p / 480p / 360p → MP4 · WebM</span>
        <span className="inline-flex items-center gap-1.5"><FileAudio className="w-3.5 h-3.5" /> Audio: 128 / 320 kbps → MP3 · WAV</span>
        <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Whitelisted: YouTube, TikTok, Instagram, X, Reddit, Pinterest, Vimeo, Twitch, Facebook, LinkedIn</span>
      </div>
    </div>
  );
}
