"use client";
import { useMemo, useState } from "react";
import {
  ClipboardPaste, Link2, ShieldCheck, ShieldAlert, Sparkles, Scissors,
  FileVideo, FileAudio, Layers, Loader2, Plus, X, CheckCircle2, AlertCircle,
} from "lucide-react";
import { api, formatCount, formatDuration, type Preview } from "@/lib/api";
import { validateUrl, parseBatchInput } from "@/lib/sanitizer";
import { useStore } from "@/lib/store";

const RESOLUTIONS = ["1080p", "720p", "480p", "360p", "best", "audio"];
const FORMATS = ["mp4", "webm", "mp3", "wav"] as const;

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

export default function ExtractionWorkspace() {
  const { previews, setPreviews, setTab, setBatchOpen } = useStore();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-preview selection state
  const [selections, setSelections] = useState<Record<string, {
    resolution: string; format: string; trimStart: string; trimEnd: string;
    subtitles: boolean; summary: boolean;
  }>>({});

  const urls = useMemo(() => parseBatchInput(input), [input]);
  const validation = useMemo(() => {
    if (!input.trim()) return null;
    const results = urls.map((u) => ({ url: u, ...validateUrl(u) }));
    return results;
  }, [input, urls]);

  const allValid = validation ? validation.every((v) => v.valid) : false;
  const validCount = validation ? validation.filter((v) => v.valid).length : 0;

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setInput((prev) => (prev ? prev + "\n" + text : text));
    } catch {
      setError("Clipboard access denied — paste manually with Ctrl+V");
    }
  }

  async function handleExtract() {
    if (!urls.length) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.extract(urls);
      setPreviews(data.previews);
      // init selections
      const init: typeof selections = {};
      data.previews.forEach((p) => {
        init[p.sanitized_url] = {
          resolution: "1080p", format: "mp4", trimStart: "", trimEnd: "",
          subtitles: true, summary: true,
        };
      });
      setSelections(init);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed");
    } finally {
      setLoading(false);
    }
  }

  async function dispatchJob(preview: Preview) {
    const sel = selections[preview.sanitized_url];
    if (!sel) return;
    try {
      await api.createJob({
        url: preview.sanitized_url,
        resolution: sel.resolution,
        format: sel.format,
        trim_start: sel.trimStart || null,
        trim_end: sel.trimEnd || null,
        generate_subtitles: sel.subtitles,
        generate_summary: sel.summary,
      });
      setTab("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to dispatch job");
    }
  }

  async function dispatchAll() {
    const valid = previews.filter((p) => p.valid);
    if (!valid.length) return;
    try {
      await api.createBatch({
        urls: valid.map((p) => p.sanitized_url),
        resolution: "1080p",
        format: "mp4",
        generate_subtitles: true,
        generate_summary: true,
      });
      setTab("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch dispatch failed");
    }
  }

  function updateSel(key: string, patch: Partial<NonNullable<typeof selections[string]>>) {
    setSelections((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  }

  return (
    <div className="space-y-6">
      {/* Paste bar */}
      <div className="rounded-2xl border border-white/10 bg-panel p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Link2 className="w-4 h-4 text-accent" /> Paste media URLs
          </h2>
          <span className="text-xs text-slate-400">Tracking params auto-stripped · SSRF sandbox active</span>
        </div>
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared\nhttps://www.tiktok.com/@techbrand/video/7345678901234?is_from_webapp=1\nhttps://www.instagram.com/reel/C3xY9z0A1bC/?igsh=MZRlODBiNWFlZA=="}
            rows={4}
            className="flex-1 rounded-xl bg-ink border border-white/10 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-accent/60 resize-y"
          />
          <div className="flex flex-col gap-2">
            <button
              onClick={pasteFromClipboard}
              className="flex items-center gap-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-slate-200 transition"
            >
              <ClipboardPaste className="w-4 h-4" /> Auto-paste
            </button>
            <button
              onClick={() => setBatchOpen(true)}
              className="flex items-center gap-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2.5 text-sm text-slate-200 transition"
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
                {v.platform ?? "invalid"} {v.valid ? "· clean" : `· ${v.error}`}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleExtract}
            disabled={loading || !urls.length}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40 transition"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
            Extract metadata
          </button>
          <span className="text-xs text-slate-400">
            {urls.length} URL{urls.length !== 1 ? "s" : ""} · {validCount} valid · max 20 per batch
          </span>
        </div>
        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
      </div>

      {/* Preview grid */}
      {previews.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">
              Preview cards ({previews.filter((p) => p.valid).length}/{previews.length} valid)
            </h3>
            <button
              onClick={dispatchAll}
              className="rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 text-xs text-slate-200 transition"
            >
              Dispatch all as jobs
            </button>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {previews.map((p, i) => {
              const sel = selections[p.sanitized_url];
              return (
                <article key={i} className="overflow-hidden rounded-2xl border border-white/10 bg-panel">
                  {p.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbnail} alt={p.title ?? "thumbnail"} className="h-40 w-full object-cover" />
                  ) : (
                    <div className="flex h-40 w-full items-center justify-center bg-ink text-slate-500 text-sm">
                      {p.valid ? "No thumbnail" : "Invalid URL"}
                    </div>
                  )}
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-semibold text-white leading-snug">{p.title ?? "Untitled"}</h4>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] capitalize ${PLATFORM_COLORS[p.platform] ?? "bg-white/5 text-slate-300 border-white/10"}`}>
                        {p.platform}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-2">{p.description ?? p.error ?? ""}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                      <span>{p.creator ?? "—"}</span>
                      <span>{formatCount(p.views)} views</span>
                      <span>{formatDuration(p.duration)}</span>
                    </div>
                    <p className="truncate text-[11px] text-slate-500" title={p.sanitized_url}>{p.sanitized_url}</p>

                    {p.valid && sel && (
                      <div className="space-y-3 border-t border-white/5 pt-3">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-400">
                            Resolution
                            <select
                              value={sel.resolution}
                              onChange={(e) => updateSel(p.sanitized_url, { resolution: e.target.value })}
                              className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            >
                              {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
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
                          <label className="text-xs text-slate-400 flex items-center gap-1.5">
                            <Scissors className="w-3.5 h-3.5" /> Start
                            <input
                              value={sel.trimStart}
                              onChange={(e) => updateSel(p.sanitized_url, { trimStart: e.target.value })}
                              placeholder="01:15"
                              className="w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            />
                          </label>
                          <label className="text-xs text-slate-400 flex items-center gap-1.5">
                            <Scissors className="w-3.5 h-3.5" /> End
                            <input
                              value={sel.trimEnd}
                              onChange={(e) => updateSel(p.sanitized_url, { trimEnd: e.target.value })}
                              placeholder="02:30"
                              className="w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white"
                            />
                          </label>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={sel.subtitles}
                            onChange={(e) => updateSel(p.sanitized_url, { subtitles: e.target.checked })}
                            className="rounded accent-violet-500"
                          />
                          <Sparkles className="w-3.5 h-3.5 text-accent" /> Generate subtitles &amp; summary
                        </label>
                        <button
                          onClick={() => dispatchJob(p)}
                          className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 transition"
                        >
                          Extract &amp; process
                        </button>
                      </div>
                    )}
                    {!p.valid && (
                      <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                        <X className="w-3.5 h-3.5" /> {p.error}
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
        <span className="inline-flex items-center gap-1.5"><FileVideo className="w-3.5 h-3.5" /> Video: 1080p / 720p / 4K / 8K → MP4 · WebM</span>
        <span className="inline-flex items-center gap-1.5"><FileAudio className="w-3.5 h-3.5" /> Audio: 128 / 320 kbps → MP3 · WAV</span>
        <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Whitelisted: YouTube, TikTok, Instagram, X, Reddit, Pinterest, Vimeo, Twitch, Facebook, LinkedIn</span>
      </div>
    </div>
  );
}
