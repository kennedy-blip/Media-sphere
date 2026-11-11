"use client";
import { getBrowserApiBase, type Job } from "./api";
import { useStore } from "./store";

/**
 * Real-time progress via WebSocket (ws/wss://…/ws/queue) with polling fallback.
 * Pushes every 200ms from backend; falls back to 1.5s polling if WS is unavailable (e.g. serverless).
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

  // Seed recorded set from already-persisted history so page reloads don't duplicate entries
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

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${base}/api/v1/jobs`);
        if (res.ok) {
          const data = await res.json();
          (data.jobs as Job[]).forEach(handleJob);
        }
      } catch {
        /* backend offline */
      }
    }, 1500);
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
        const delay = Math.min(15000, 3000 * consecutiveFailures);
        reconnectTimer = setTimeout(connect, delay);
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
