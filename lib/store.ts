"use client";
import { create } from "zustand";
import type { Job, Preview } from "./api";
import { addHistory, getAllHistory, type HistoryRecord } from "./indexeddb";

export type Tab = "extract" | "active" | "completed" | "history";

interface MediaStore {
  tab: Tab;
  setTab: (t: Tab) => void;
  jobs: Job[];
  setJobs: (jobs: Job[]) => void;
  upsertJob: (job: Job) => void;
  previews: Preview[];
  setPreviews: (p: Preview[]) => void;
  history: HistoryRecord[];
  loadHistory: () => Promise<void>;
  recordHistory: (job: Job) => Promise<void>;
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
  batchOpen: boolean;
  setBatchOpen: (v: boolean) => void;
}

export const useStore = create<MediaStore>((set, get) => ({
  tab: "extract",
  setTab: (tab) => set({ tab }),
  jobs: [],
  setJobs: (jobs) => set({ jobs }),
  upsertJob: (job) =>
    set((s) => {
      const idx = s.jobs.findIndex((j) => j.id === job.id);
      if (idx === -1) return { jobs: [job, ...s.jobs] };
      const next = [...s.jobs];
      next[idx] = job;
      return { jobs: next };
    }),
  previews: [],
  setPreviews: (previews) => set({ previews }),
  history: [],
  loadHistory: async () => {
    try {
      const rows = await getAllHistory();
      set({ history: rows });
    } catch {
      /* IndexedDB unavailable */
    }
  },
  recordHistory: async (job) => {
    const record: HistoryRecord = {
      id: `${job.id}-${Date.now()}`,
      jobId: job.id,
      url: job.url,
      sanitizedUrl: job.sanitized_url,
      platform: job.platform,
      title: job.title,
      resolution: job.resolution,
      format: job.format,
      trimStart: job.trim_start,
      trimEnd: job.trim_end,
      status: job.status,
      createdAt: Date.now(),
      fileSize: job.file_size,
      transcript: job.transcript ?? null,
      summary: job.summary ?? null,
    };
    try {
      await addHistory(record);
      set({ history: [record, ...get().history] });
    } catch {
      /* ignore */
    }
  },
  wsConnected: false,
  setWsConnected: (wsConnected) => set({ wsConnected }),
  batchOpen: false,
  setBatchOpen: (batchOpen) => set({ batchOpen }),
}));
