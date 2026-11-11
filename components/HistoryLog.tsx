"use client";
import { useEffect, useMemo, useState } from "react";
import { History, Search, Trash2, RotateCcw, Filter, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { deleteHistory, clearHistory, type HistoryRecord } from "@/lib/indexeddb";

const PLATFORMS = ["all", "youtube", "tiktok", "instagram", "x", "reddit", "pinterest", "vimeo", "twitch", "facebook", "linkedin"];

export default function HistoryLog() {
  const { history, loadHistory, upsertJob, setTab } = useStore();
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const filtered = useMemo(() => {
    return history.filter((r) => {
      const matchPlatform = platform === "all" || r.platform === platform;
      const q = query.toLowerCase();
      const matchQuery = !q || r.title.toLowerCase().includes(q) || r.sanitizedUrl.toLowerCase().includes(q);
      return matchPlatform && matchQuery;
    });
  }, [history, query, platform]);

  async function reExtract(r: HistoryRecord) {
    setError(null);
    try {
      const job = await api.createJob({
        url: r.sanitizedUrl,
        resolution: r.resolution || "1080p",
        format: r.format || "mp4",
        trim_start: r.trimStart ?? null,
        trim_end: r.trimEnd ?? null,
        generate_subtitles: true,
        generate_summary: true,
      });
      upsertJob(job);
      setTab("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to re-extract item");
    }
  }

  async function remove(id: string) {
    await deleteHistory(id);
    loadHistory();
  }

  async function clearAll() {
    await clearHistory();
    loadHistory();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <History className="w-4 h-4 text-accent" /> History &amp; collections
          <span className="text-xs font-normal text-slate-500">Stored locally in IndexedDB · no account needed</span>
        </h2>
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 transition"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear all
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles or URLs…"
            className="w-full rounded-xl bg-panel border border-white/10 pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-accent/60"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Filter className="w-4 h-4 text-slate-500 mt-2" />
          {PLATFORMS.map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => setPlatform(p)}
              className={`rounded-full border px-2.5 py-1 text-xs capitalize transition ${
                platform === p
                  ? "border-accent/50 bg-accent/15 text-white"
                  : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Platform</th>
              <th className="px-4 py-3 font-medium">Format</th>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{r.title}</div>
                  <div className="truncate max-w-md text-xs text-slate-500">{r.sanitizedUrl}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-300">{r.platform}</span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {r.resolution} · {r.format.toUpperCase()}
                  {(r.trimStart || r.trimEnd) && (
                    <div className="text-[11px] text-slate-500">Trim {r.trimStart ?? "00:00"}–{r.trimEnd ?? "end"}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => reExtract(r)}
                      title="Re-extract"
                      className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Re-extract
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      title="Delete record"
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-white/10 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">
                  No history yet — completed jobs are logged here automatically.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
