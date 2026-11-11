"use client";
import { useMemo, useState } from "react";
import { X, Layers, Loader2, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { parseBatchInput, validateUrl } from "@/lib/sanitizer";
import { useStore } from "@/lib/store";

export default function BatchDrawer() {
  const { batchOpen, setBatchOpen, setTab } = useStore();
  const [text, setText] = useState("");
  const [resolution, setResolution] = useState("1080p");
  const [format, setFormat] = useState("mp4");
  const [subtitles, setSubtitles] = useState(true);
  const [summary, setSummary] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const urls = useMemo(() => parseBatchInput(text), [text]);
  const validUrls = useMemo(() => urls.filter((u) => validateUrl(u).valid), [urls]);

  if (!batchOpen) return null;

  async function submit() {
    if (!validUrls.length) {
      setError("No valid URLs in batch input");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.createBatch({
        urls: validUrls, resolution, format,
        generate_subtitles: subtitles, generate_summary: summary,
      });
      setResult(`Dispatched ${data.created} job(s)${data.errors.length ? ` · ${data.errors.length} skipped (invalid)` : ""}`);
      setTimeout(() => {
        setBatchOpen(false);
        setTab("active");
      }, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch dispatch failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center" onClick={() => setBatchOpen(false)}>
      <div
        className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl border border-white/10 bg-panel p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-accent" /> Batch processing drawer
          </h3>
          <button onClick={() => setBatchOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Paste multiple URLs — one per line or comma-separated:\nhttps://www.youtube.com/watch?v=…\nhttps://www.tiktok.com/@…/video/…\nhttps://www.instagram.com/reel/…"}
          rows={8}
          className="w-full rounded-xl bg-ink border border-white/10 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-accent/60"
        />
        <p className="mt-2 text-xs text-slate-400">{urls.length} parsed · {validUrls.length} valid · max 20</p>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-400">
            Resolution
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white">
              {["1080p", "720p", "480p", "360p", "best", "audio"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value)} className="mt-1 w-full rounded-lg bg-ink border border-white/10 px-2 py-2 text-xs text-white">
              {["mp4", "webm", "mp3", "wav"].map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-3 space-y-2 text-xs text-slate-300">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} className="rounded accent-violet-500" />
            Generate subtitles (.SRT)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={summary} onChange={(e) => setSummary(e.target.checked)} className="rounded accent-violet-500" />
            Generate AI summary
          </label>
        </div>

        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {result && (
          <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{result}</div>
        )}

        <button
          onClick={submit}
          disabled={loading || !validUrls.length}
          className="mt-4 w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40 transition inline-flex items-center justify-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
          Dispatch {validUrls.length} job{validUrls.length !== 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}
