"use client";
import { useEffect } from "react";
import { Globe, Download, CheckCircle2, History, Zap, ShieldCheck } from "lucide-react";
import { useStore, type Tab } from "@/lib/store";
import { connectProgressFeed } from "@/lib/socket";
import { api } from "@/lib/api";
import ExtractionWorkspace from "@/components/ExtractionWorkspace";
import ActiveDownloads from "@/components/ActiveDownloads";
import CompletedDownloads from "@/components/CompletedDownloads";
import HistoryLog from "@/components/HistoryLog";
import BatchDrawer from "@/components/BatchDrawer";

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "extract", label: "Extraction Workspace", icon: <Globe className="w-4 h-4" /> },
  { id: "active", label: "Active Downloads", icon: <Download className="w-4 h-4" /> },
  { id: "completed", label: "Completed", icon: <CheckCircle2 className="w-4 h-4" /> },
  { id: "history", label: "History & Collections", icon: <History className="w-4 h-4" /> },
];

export default function Home() {
  const { tab, setTab, jobs, setJobs, wsConnected, loadHistory } = useStore();

  useEffect(() => {
    const disconnect = connectProgressFeed();
    loadHistory();
    // Initial job list fetch
    api.listJobs().then((d) => setJobs(d.jobs)).catch(() => {});
    return disconnect;
  }, [loadHistory, setJobs]);

  const activeCount = jobs.filter((j) => !["ready", "cancelled"].includes(j.status)).length;
  const doneCount = jobs.filter((j) => j.status === "ready").length;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-white/10 bg-panel/80 backdrop-blur sticky top-0 z-40">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-mint">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white leading-tight">MediaSphere</h1>
              <p className="text-[11px] text-slate-400 leading-tight">Extract · Trim · Transcribe · Convert</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> SSRF sandbox · https only
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
              wsConnected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? "bg-emerald-400" : "bg-amber-400"}`} />
              {wsConnected ? "WSS live" : "Polling"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* Tabs */}
        <nav className="mb-6 flex flex-wrap gap-2">
          {TABS.map((t) => {
            const isActive = tab === t.id;
            const badge = t.id === "active" ? activeCount : t.id === "completed" ? doneCount : null;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? "border-accent/50 bg-accent/15 text-white"
                    : "border-white/10 bg-panel text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                {t.icon}
                {t.label}
                {badge != null && badge > 0 && (
                  <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white">{badge}</span>
                )}
              </button>
            );
          })}
        </nav>

        {tab === "extract" && <ExtractionWorkspace />}
        {tab === "active" && <ActiveDownloads />}
        {tab === "completed" && <CompletedDownloads />}
        {tab === "history" && <HistoryLog />}

        <footer className="mt-10 border-t border-white/5 pt-4 text-center text-xs text-slate-600">
          MediaSphere · yt-dlp + FFmpeg + Faster-Whisper pipeline · Files expire after 15 min (ephemeral storage)
        </footer>
      </main>

      <BatchDrawer />
    </div>
  );
}
