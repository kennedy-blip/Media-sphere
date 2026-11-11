"use client";
import { getBrowserApiBase, type Job } from "./api";
import { useStore } from "./store";

/**
 * Real-time progress via WebSocket (ws/wss://…/ws/queue) with polling fallback.
 * Pushes every 200ms from FastAPI; falls back to 1.2s polling in serverless environments (e.g. Vercel).
 */
export function connectProgressFeed() {
  const { upsertJob, setWsConnected, recordHistory } = useStore.getState();
  const base = getBrowserApiBase();
  const wsUrl = base
    ? base.replace(/^http/, "ws") + "/ws/queue"
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/queue`;

  let ws: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let consecutiveFailures = 0;

  const recorded = new Set<string>();
  for (const h of useStore.getState().history) {
    recorded.add(h.jobId);
  }

  function handleJob(job: Job) {
    upsertJob(job);
    if (job.status === "ready" && !recorded.has(job.id)) {
      recorded.add(job.id);
      recordHistory(job);
    }
  }

  async function pollOnce() {
    const seen = new Set<string>();
    try {
      const res = await fetch(`${base}/api/v1/jobs`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        for (const j of (data.jobs as Job[]) || []) {
          seen.add(j.id);
          handleJob(j);
        }
      }
    } catch {
      /* ignore */
    }

    // In multi-instance serverless environments, also refresh any active job not yet in the current isolate's list
    const pending = useStore
      .getState()
      .jobs.filter((j) => !["ready", "failed", "cancelled"].includes(j.status) && !seen.has(j.id));
    await Promise.all(
      pending.map(async (p) => {
        try {
          const r = await fetch(`${base}/api/v1/jobs/${encodeURIComponent(p.id)}`, { cache: "no-store" });
          if (r.ok) {
            handleJob((await r.json()) as Job);
          }
        } catch {
          /* ignore */
        }
      })
    );
  }

  function startPolling() {
    if (pollTimer) return;
    void pollOnce();
    pollTimer = setInterval(pollOnce, 1200);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      startPolling();
      return;
    }
    ws.onopen = () => {
      consecutiveFailures = 0;
      setWsConnected(true);
      stopPolling();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "job_update" && msg.job) handleJob(msg.job as Job);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      setWsConnected(false);
      consecutiveFailures += 1;
      if (!closed) {
        startPolling();
        // Avoid noisy infinite reconnect loops on pure serverless hosts without WS endpoints
        if (consecutiveFailures <= 3) {
          reconnectTimer = setTimeout(connect, 4000 * consecutiveFailures);
        }
      }
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }

  connect();
  return () => {
    closed = true;
    stopPolling();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}
