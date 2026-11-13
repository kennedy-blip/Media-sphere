/**
 * Multi-Engine Resilient Media Stream Resolver (Vercel / Cloud Datacenter Ready).
 *
 * Ordered & Raced Stream Providers for YouTube:
 * 1. SaveTube Multi-CDN (`cdn400–cdn406.savetube.vip` + `media.savetube.vip` / `media.savetube.me`):
 *    - AES-128-CBC `/v2/info` -> `/download` on the SAME CDN node that minted `info.key`,
 *      sending `{ id, key, downloadType, quality }` with automatic quality (`720 -> 480 -> 360`)
 *      and multi-node failover.
 * 2. VidsSave API (`api.vidssave.com/api/contentsite_api/media/parse`):
 *    - Returns direct CDN `download_url` video & audio resources from cloud IPs.
 * 3. Live 2026 Piped & Invidious Proxy Fleet (`pipedapi.ducks.party`, `api.piped.private.coffee`,
 *    etc. + runtime registry discovery, supporting MP4, adaptive mux, and `.m3u8` HLS).
 * 4. Direct YouTube InnerTube (`VISIONOS` 1.02 w/ `visitorData`, `youtubei.js` `ANDROID_VR`/`IOS`).
 */
import { safeFetch, assertPublicHttpUrl } from "./outboundSecurity";
import { createDecipheriv } from "crypto";
import { Innertube, ClientType } from "youtubei.js";

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const VISIONOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

export interface ResolvedStream {
  videoUrl?: string;
  audioUrl?: string;
  headers?: Record<string, string>;
  isHls?: boolean;
  provider: string;
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

export function normalizeHttpUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Empty stream URL returned by provider");
  }
  const parsed = assertPublicHttpUrl(raw.trim());
  return parsed.toString();
}

export function isHlsManifestUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || /\/api\/manifest\/hls/i.test(url);
}

/**
 * Probes the first <= 64 KiB of multi-use streams (googlevideo / Piped / Invidious)
 * to reject IP-blocked 403s or HTML error pages immediately.
 */
export async function probeMediaStreamUrl(
  rawUrl: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  timeoutMs = 12000
): Promise<{ url: string; isHls: boolean }> {
  const normalized = normalizeHttpUrl(rawUrl);
  const looksLikeHls = isHlsManifestUrl(normalized);

  const reqHeaders: Record<string, string> = {
    "User-Agent": DESKTOP_UA,
    Accept: "*/*",
    ...headers,
  };
  if (!looksLikeHls) {
    reqHeaders.Range = "bytes=0-65535";
  }

  const res = await safeFetch(normalized, {
    method: "GET",
    headers: reqHeaders,
    redirect: "follow",
    signal: combineSignal(signal, timeoutMs),
  });

  if ((!res.ok && res.status !== 206) || !res.body) {
    throw new Error(`Stream probe HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  try {
    const { done, value } = await reader.read();
    if (done || !value || value.byteLength === 0) {
      throw new Error("Stream probe returned 0 bytes");
    }
    const sample = Buffer.from(value.subarray(0, Math.min(320, value.byteLength)))
      .toString("latin1")
      .trimStart();
    const lower = sample.toLowerCase();

    if (lower.startsWith("#extm3u")) {
      return { url: normalizeHttpUrl(res.url || normalized), isHls: true };
    }
    if (
      lower.startsWith("<!doctype") ||
      lower.startsWith("<html") ||
      lower.startsWith("<head") ||
      lower.startsWith("<body") ||
      lower.startsWith('{"error') ||
      lower.startsWith('{"message') ||
      lower.startsWith('{"status":false') ||
      lower.startsWith('{"success":false')
    ) {
      throw new Error("Stream probe detected HTML/JSON error payload");
    }
    if (looksLikeHls) {
      throw new Error("Expected #EXTM3U HLS playlist");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { url: normalizeHttpUrl(res.url || normalized), isHls: false };
}

function snapQuality(targetHeight: number, allowed = [1080, 720, 480, 360]): number {
  const sorted = [...allowed].sort((a, b) => b - a);
  return sorted.find((q) => q <= targetHeight) ?? sorted[sorted.length - 1];
}

// ============================================================================
// ENGINE 1: SAVETUBE MULTI-CDN RELAY (SAME-NODE KEY BINDING + `{ id, key }`)
// ============================================================================

const SAVETUBE_STATIC_CDNS = [
  "cdn406.savetube.vip",
  "cdn405.savetube.vip",
  "cdn404.savetube.vip",
  "cdn403.savetube.vip",
  "cdn402.savetube.vip",
  "cdn401.savetube.vip",
  "cdn400.savetube.vip",
];

const SAVETUBE_RANDOM_ENDPOINTS = [
  "https://media.savetube.vip/api/random-cdn",
  "https://media.savetube.me/api/random-cdn",
];

const SAVETUBE_AES_KEY = Buffer.from("C5D58EF67A7584E4A29F6C35BBC4EB12", "hex");

const SAVETUBE_API_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: "https://yt.savetube.me",
  Referer: "https://yt.savetube.me/",
  "User-Agent": DESKTOP_UA,
};

const SAVETUBE_MEDIA_HEADERS: Record<string, string> = {
  Referer: "https://yt.savetube.me/",
  "User-Agent": DESKTOP_UA,
};

interface SaveTubeMeta {
  id: string;
  key: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  video_formats?: Array<{ quality?: number | string; height?: number | string }>;
  audio_formats?: Array<{ quality?: number | string }>;
}

function decryptSaveTubePayload(encoded: string): SaveTubeMeta {
  const raw = Buffer.from(String(encoded).replace(/\s/g, ""), "base64");
  if (raw.length <= 16) throw new Error("Invalid SaveTube encrypted payload");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = createDecipheriv("aes-128-cbc", SAVETUBE_AES_KEY, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as SaveTubeMeta;
}

async function discoverSaveTubeCdns(signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  await Promise.allSettled(
    SAVETUBE_RANDOM_ENDPOINTS.map(async (ep) => {
      const res = await safeFetch(ep, {
        headers: SAVETUBE_API_HEADERS,
        redirect: "follow",
        signal: combineSignal(signal, 6000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { cdn?: string; data?: { cdn?: string } };
      const cdn = json?.cdn || json?.data?.cdn;
      if (cdn && typeof cdn === "string") {
        found.push(cdn.trim());
      }
    })
  );
  return Array.from(new Set([...found, ...SAVETUBE_STATIC_CDNS]));
}

async function fetchSaveTubeNodeInfo(
  cdn: string,
  watchUrl: string,
  signal?: AbortSignal
): Promise<{ cdn: string; info: SaveTubeMeta }> {
  const res = await safeFetch(`https://${cdn}/v2/info`, {
    method: "POST",
    headers: SAVETUBE_API_HEADERS,
    body: JSON.stringify({ url: watchUrl }),
    redirect: "follow",
    signal: combineSignal(signal, 18000),
  });
  const json = (await res.json().catch(() => null)) as {
    status?: boolean;
    data?: string;
    message?: string;
  } | null;
  if (!res.ok || !json?.data) {
    throw new Error(json?.message || `SaveTube ${cdn} info HTTP ${res.status}`);
  }
  const info = decryptSaveTubePayload(json.data);
  if (!info?.key) {
    throw new Error(`SaveTube ${cdn} returned no key`);
  }
  return { cdn, info };
}

async function requestSaveTubeDownloadLink(
  cdn: string,
  videoId: string,
  key: string,
  downloadType: "video" | "audio",
  quality: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await safeFetch(`https://${cdn}/download`, {
    method: "POST",
    headers: SAVETUBE_API_HEADERS,
    body: JSON.stringify({
      id: videoId,
      downloadType,
      quality,
      key,
    }),
    redirect: "follow",
    signal: combineSignal(signal, 55000),
  });
  const json = (await res.json().catch(() => null)) as {
    status?: boolean;
    downloadUrl?: string;
    data?: { downloadUrl?: string; download_url?: string };
    message?: string;
  } | null;
  const link = json?.data?.downloadUrl || json?.data?.download_url || json?.downloadUrl;
  if (!link || typeof link !== "string") {
    throw new Error(json?.message || `SaveTube ${cdn} ${quality} returned no downloadUrl`);
  }
  return normalizeHttpUrl(link);
}

export async function resolveViaSaveTube(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cdns = await discoverSaveTubeCdns(signal);

  // Query up to 5 CDN nodes in parallel for /v2/info so we have healthy nodes ready
  const settledInfos = await Promise.allSettled(
    cdns.slice(0, 5).map((cdn) => fetchSaveTubeNodeInfo(cdn, watchUrl, signal))
  );
  const readyNodes = settledInfos
    .filter((r): r is PromiseFulfilledResult<{ cdn: string; info: SaveTubeMeta }> => r.status === "fulfilled")
    .map((r) => r.value);

  if (readyNodes.length === 0) {
    const firstRej = settledInfos.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw new Error(firstRej ? String(firstRej.reason?.message || firstRej.reason) : "SaveTube /v2/info failed on all CDNs");
  }

  let lastErr: unknown = null;

  // Try up to 3 distinct ready CDN nodes; CRITICAL: always send /download to the SAME `cdn` that minted `info.key`!
  for (const { cdn, info } of readyNodes.slice(0, 3)) {
    const resolvedId = info.id || videoId;

    if (wantAudioOnly) {
      for (const audioQ of ["128", "320"]) {
        try {
          const link = await requestSaveTubeDownloadLink(cdn, resolvedId, info.key, "audio", audioQ, signal);
          return { audioUrl: link, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}` };
        } catch (err) {
          lastErr = err;
        }
      }
      continue;
    }

    // Video qualities: prefer requested height (720/1080/480/360), then cascade 720 -> 480 -> 360
    const preferred = String(snapQuality(targetHeight, [1080, 720, 480, 360]));
    const qualityOrder = Array.from(new Set([preferred, "720", "480", "360"]));

    for (const q of qualityOrder) {
      try {
        const link = await requestSaveTubeDownloadLink(cdn, resolvedId, info.key, "video", q, signal);
        return { videoUrl: link, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}:${q}p` };
      } catch (err) {
        lastErr = err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("SaveTube download failed across CDN nodes");
}

// ============================================================================
// ENGINE 2: VIDSSAVE API (`api.vidssave.com/api/contentsite_api/media/parse`)
// ============================================================================

export async function resolveViaVidsSave(
  videoIdOrUrl: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const link = videoIdOrUrl.startsWith("http")
    ? videoIdOrUrl
    : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

  const body = new URLSearchParams({
    auth: "20250901majwlqo",
    domain: "api-ak.vidssave.com",
    origin: "cache",
    link,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Accept: "application/json, text/plain, */*",
    Origin: "https://vidssave.com",
    Referer: "https://vidssave.com/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": DESKTOP_UA,
  };

  const res = await safeFetch("https://api.vidssave.com/api/contentsite_api/media/parse", {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "follow",
    signal: combineSignal(signal, 18000),
  });

  const json = (await res.json().catch(() => null)) as {
    status?: number;
    data?: {
      resources?: Array<{
        type?: string;
        format?: string;
        quality?: string | number;
        download_url?: string;
      }>;
    };
  } | null;

  if (!res.ok || json?.status !== 1 || !Array.isArray(json?.data?.resources)) {
    throw new Error(`VidsSave HTTP ${res.status}`);
  }

  const dlHeaders = {
    Referer: "https://vidssave.com/",
    "User-Agent": DESKTOP_UA,
  };

  const resources = json.data.resources.filter((r) => typeof r.download_url === "string" && r.download_url.startsWith("http"));
  if (!resources.length) {
    throw new Error("VidsSave returned empty resources");
  }

  if (wantAudioOnly) {
    const aud = resources.find((r) => r.type === "audio") || resources[0];
    return {
      audioUrl: normalizeHttpUrl(aud.download_url!),
      headers: dlHeaders,
      provider: "vidssave",
    };
  }

  const vids = resources
    .filter((r) => r.type === "video")
    .map((r) => ({
      url: r.download_url!,
      height: parseInt(String(r.quality ?? "720").replace(/\D/g, ""), 10) || 720,
    }))
    .sort((a, b) => b.height - a.height);

  const chosen = vids.find((v) => v.height <= targetHeight) || vids[vids.length - 1];
  if (!chosen) {
    throw new Error("VidsSave returned no video stream");
  }

  return {
    videoUrl: normalizeHttpUrl(chosen.url),
    headers: dlHeaders,
    provider: `vidssave:${chosen.height}p`,
  };
}

// ============================================================================
// ENGINE 3: LIVE PIPED & INVIDIOUS PROXY FLEET (2026 Verified + Dynamic Registry)
// ============================================================================

const BUILTIN_PIPED_APIS = [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
  "https://pipedapi.syncpundit.io",
  "https://pipedapi.aeong.one",
  "https://pipedapi.moomoo.me",
  "https://pipedapi.tokhmi.xyz",
];

const BLOCKED_PROXY_HOSTS =
  /inv\.nadeko\.net|nadeko\.ygg|yewtu\.be|nerdvpn|tiekoetter|chocolatemoo53|thepixora|pipedapi\.kavin\.rocks|adminforge|leptons|invidious\.f5\.si|reallyaweso|darkness\.services|orangenet|drgns|api\.piped\.yt|r4fo|nosebs|ngn\.tf|privacy\.com\.de/i;

export interface LivePipedData {
  title?: string;
  description?: string;
  uploader?: string;
  uploaderAvatar?: string;
  thumbnailUrl?: string;
  views?: number;
  likes?: number;
  uploadDate?: string;
  duration?: number;
  hls?: string;
  videoStreams?: Array<{
    url?: string;
    quality?: string;
    format?: string;
    height?: number;
    fps?: number;
    videoOnly?: boolean;
    contentLength?: number;
  }>;
  audioStreams?: Array<{
    url?: string;
    mimeType?: string;
    bitrate?: number;
    contentLength?: number;
  }>;
  subtitles?: Array<{ url?: string; code?: string; autoGenerated?: boolean }>;
}

let discoveredCache: { at: number; piped: string[]; invidious: string[] } | null = null;

async function getLiveProxyBases(signal?: AbortSignal): Promise<{ piped: string[]; invidious: string[] }> {
  if (discoveredCache && Date.now() - discoveredCache.at < 30 * 60 * 1000) {
    return discoveredCache;
  }
  const piped = new Set<string>(BUILTIN_PIPED_APIS);
  const invidious = new Set<string>();

  const [pReg, iReg] = await Promise.allSettled([
    safeFetch("https://piped-instances.kavin.rocks/", {
      headers: { "User-Agent": DESKTOP_UA },
      signal: combineSignal(signal, 4500),
    }).then((r) => (r.ok ? r.json() : [])),
    safeFetch("https://api.invidious.io/instances.json?sort_by=health", {
      headers: { "User-Agent": DESKTOP_UA },
      signal: combineSignal(signal, 4500),
    }).then((r) => (r.ok ? r.json() : [])),
  ]);

  if (pReg.status === "fulfilled" && Array.isArray(pReg.value)) {
    for (const item of pReg.value) {
      const u = typeof item?.api_url === "string" ? item.api_url.trim().replace(/\/+$/, "") : "";
      if (u.startsWith("https://") && !BLOCKED_PROXY_HOSTS.test(u)) {
        piped.add(u);
      }
    }
  }
  if (iReg.status === "fulfilled" && Array.isArray(iReg.value)) {
    for (const entry of iReg.value) {
      const info = Array.isArray(entry) ? entry[1] : null;
      const u = typeof info?.uri === "string" ? info.uri.trim().replace(/\/+$/, "") : "";
      if (info?.type === "https" && info?.api && u.startsWith("https://") && !BLOCKED_PROXY_HOSTS.test(u)) {
        invidious.add(u);
      }
    }
  }

  discoveredCache = {
    at: Date.now(),
    piped: [...piped].slice(0, 10),
    invidious: [...invidious].slice(0, 6),
  };
  return discoveredCache;
}

export async function fetchLivePipedStreams(videoId: string, signal?: AbortSignal): Promise<LivePipedData | null> {
  const { piped } = await getLiveProxyBases(signal);
  const batch = piped.slice(0, 6);
  if (!batch.length) return null;

  try {
    return await Promise.any(
      batch.map(async (base) => {
        const res = await safeFetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
          headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
          signal: combineSignal(signal, 6500),
        });
        if (!res.ok) throw new Error(`${base} HTTP ${res.status}`);
        const data = (await res.json()) as LivePipedData;
        if (!data?.title) throw new Error(`${base} missing title`);
        if (!data.videoStreams?.length && !data.audioStreams?.length && !data.hls) {
          throw new Error(`${base} returned no streams`);
        }
        return data;
      })
    );
  } catch {
    return null;
  }
}

export async function resolveViaPipedAndInvidious(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const { piped, invidious } = await getLiveProxyBases(signal);
  const tasks: Array<Promise<ResolvedStream>> = [];

  for (const base of piped.slice(0, 6)) {
    tasks.push(
      (async () => {
        const res = await safeFetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
          headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
          signal: combineSignal(signal, 8000),
        });
        if (!res.ok) throw new Error(`Piped ${base} HTTP ${res.status}`);
        const data = (await res.json()) as LivePipedData;

        const bestAudio = [...(data.audioStreams || [])]
          .filter((a) => a.url && !/lbry|odysee/i.test(a.url))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

        if (wantAudioOnly) {
          if (bestAudio?.url) {
            const p = await probeMediaStreamUrl(bestAudio.url, {}, signal, 10000);
            return { audioUrl: p.url, isHls: p.isHls, provider: `piped:${base}` };
          }
          if (data.hls) {
            const p = await probeMediaStreamUrl(data.hls, {}, signal, 10000);
            return { audioUrl: p.url, isHls: true, provider: `piped-hls:${base}` };
          }
          throw new Error("No Piped audio stream");
        }

        const muxed = [...(data.videoStreams || [])]
          .filter((v) => v.url && !v.videoOnly && !/lbry|odysee/i.test(v.url) && (v.height || 720) <= targetHeight)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (muxed?.url) {
          const p = await probeMediaStreamUrl(muxed.url, {}, signal, 10000);
          return { videoUrl: p.url, isHls: p.isHls, provider: `piped:${base}` };
        }

        const adaptiveVid = [...(data.videoStreams || [])]
          .filter((v) => v.url && !/lbry|odysee/i.test(v.url) && (v.height || 1080) <= targetHeight)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (adaptiveVid?.url && bestAudio?.url) {
          const [pv, pa] = await Promise.all([
            probeMediaStreamUrl(adaptiveVid.url, {}, signal, 10000),
            probeMediaStreamUrl(bestAudio.url, {}, signal, 10000),
          ]);
          return { videoUrl: pv.url, audioUrl: pa.url, isHls: pv.isHls, provider: `piped-mux:${base}` };
        }

        if (data.hls) {
          const p = await probeMediaStreamUrl(data.hls, {}, signal, 10000);
          return { videoUrl: p.url, isHls: true, provider: `piped-hls:${base}` };
        }

        throw new Error(`No usable stream from ${base}`);
      })()
    );
  }

  for (const base of invidious.slice(0, 4)) {
    tasks.push(
      (async () => {
        const res = await safeFetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
          headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
          signal: combineSignal(signal, 8000),
        });
        if (!res.ok) throw new Error(`Invidious ${base} HTTP ${res.status}`);
        const data = (await res.json()) as {
          formatStreams?: Array<{ itag?: string; resolution?: string }>;
          adaptiveFormats?: Array<{ itag?: string; type?: string }>;
        };
        if (wantAudioOnly) {
          const aud = (data.adaptiveFormats || []).find((f) => f.type?.startsWith("audio/") && f.itag);
          if (!aud?.itag) throw new Error("No Invidious audio itag");
          const link = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=${aud.itag}&local=true`;
          const p = await probeMediaStreamUrl(link, {}, signal, 10000);
          return { audioUrl: p.url, isHls: p.isHls, provider: `invidious:${base}` };
        }
        const mux = (data.formatStreams || [])[0];
        if (!mux?.itag) throw new Error("No Invidious muxed itag");
        const link = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=${mux.itag}&local=true`;
        const p = await probeMediaStreamUrl(link, {}, signal, 10000);
        return { videoUrl: p.url, isHls: p.isHls, provider: `invidious:${base}` };
      })()
    );
  }

  if (!tasks.length) throw new Error("No Piped/Invidious instances available");
  return await Promise.any(tasks);
}

// ============================================================================
// ENGINE 4: DIRECT YOUTUBE INNERTUBE (VISIONOS w/ visitorData + ANDROID_VR + IOS)
// ============================================================================

let cachedVisitorData: { token: string; at: number } | null = null;

async function fetchYoutubeVisitorData(signal?: AbortSignal): Promise<string | undefined> {
  if (cachedVisitorData && Date.now() - cachedVisitorData.at < 15 * 60 * 1000) {
    return cachedVisitorData.token;
  }
  try {
    const res = await safeFetch("https://www.youtube.com/sw.js_data", {
      headers: { "User-Agent": VISIONOS_UA, Accept: "*/*" },
      signal: combineSignal(signal, 4500),
    });
    if (res.ok) {
      const txt = (await res.text()).replace(/^\)\]\}'\s*/, "");
      const m = txt.match(/"(Cg[A-Za-z0-9_-]{16,}[%3D=]*)"/);
      if (m?.[1]) {
        cachedVisitorData = { token: m[1], at: Date.now() };
        return m[1];
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

interface RawItFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  height?: number;
  bitrate?: number;
}

export async function resolveViaInnerTubeDirect(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  try {
    const visitorData = await fetchYoutubeVisitorData(signal);
    const res = await safeFetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": VISIONOS_UA,
        "X-YouTube-Client-Name": "101",
        "X-YouTube-Client-Version": "1.02",
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "VISIONOS",
            clientVersion: "1.02",
            deviceMake: "Apple",
            deviceModel: "RealityDevice17,1",
            userAgent: VISIONOS_UA,
            osName: "visionOS",
            osVersion: "26.5.23O471",
            hl: "en",
            gl: "US",
            ...(visitorData ? { visitorData } : {}),
          },
        },
      }),
      signal: combineSignal(signal, 8000),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        playabilityStatus?: { status?: string };
        streamingData?: {
          formats?: RawItFormat[];
          adaptiveFormats?: RawItFormat[];
          hlsManifestUrl?: string;
        };
      };
      if (data.playabilityStatus?.status === "OK" && data.streamingData) {
        const sd = data.streamingData;
        const headers = { "User-Agent": VISIONOS_UA };
        if (wantAudioOnly) {
          const aud = [...(sd.adaptiveFormats || [])]
            .filter((f) => f.url && f.mimeType?.startsWith("audio/"))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (aud?.url) {
            const p = await probeMediaStreamUrl(aud.url, headers, signal, 8000);
            return { audioUrl: p.url, headers, isHls: p.isHls, provider: "innertube:visionos" };
          }
        } else {
          const mux = [...(sd.formats || [])]
            .filter((f) => f.url && (f.height || 360) <= targetHeight)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (mux?.url) {
            const p = await probeMediaStreamUrl(mux.url, headers, signal, 8000);
            return { videoUrl: p.url, headers, isHls: p.isHls, provider: "innertube:visionos" };
          }
          if (sd.hlsManifestUrl) {
            const p = await probeMediaStreamUrl(sd.hlsManifestUrl, headers, signal, 8000);
            return { videoUrl: p.url, headers, isHls: true, provider: "innertube:visionos-hls" };
          }
        }
      }
    }
  } catch {
    /* try next client */
  }

  try {
    const yt = await Innertube.create({ retrieve_player: false, fetch: safeFetch });
    for (const client of [ClientType.ANDROID_VR, ClientType.IOS]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = await yt.getBasicInfo(videoId, { client: client as any });
        const sd = info.streaming_data;
        if (!sd) continue;
        const ua = client === ClientType.ANDROID_VR ? ANDROID_UA : VISIONOS_UA;
        const headers = { "User-Agent": ua };

        if (wantAudioOnly) {
          const aud = [...(sd.adaptive_formats || [])]
            .filter((f) => f.url && f.has_audio && !f.has_video)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (aud?.url) {
            const p = await probeMediaStreamUrl(aud.url, headers, signal, 8000);
            return { audioUrl: p.url, headers, isHls: p.isHls, provider: `youtubei:${client}` };
          }
        } else {
          const mux = [...(sd.formats || [])]
            .filter((f) => f.url && f.has_video && f.has_audio && (f.height || 360) <= targetHeight)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (mux?.url) {
            const p = await probeMediaStreamUrl(mux.url, headers, signal, 8000);
            return { videoUrl: p.url, headers, isHls: p.isHls, provider: `youtubei:${client}` };
          }
          if (sd.hls_manifest_url) {
            const p = await probeMediaStreamUrl(sd.hls_manifest_url, headers, signal, 8000);
            return { videoUrl: p.url, headers, isHls: true, provider: `youtubei-hls:${client}` };
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  throw new Error("Direct InnerTube blocked on current IP");
}

// ============================================================================
// ORDERED CANDIDATE LIST FOR DOWNLOAD-TIME FAILOVER
// ============================================================================

/**
 * Returns an ordered list of stream resolver thunks so that if downloading the
 * bytes of Provider 1 fails mid-flight, `realProcessor.ts` seamlessly tries Provider 2+.
 */
export function getYoutubeCandidateResolvers(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number
): Array<{ name: string; resolve: () => Promise<ResolvedStream> }> {
  return [
    {
      name: "SaveTube",
      resolve: () => resolveViaSaveTube(videoId, wantAudioOnly, targetHeight),
    },
    {
      name: "VidsSave",
      resolve: () => resolveViaVidsSave(videoId, wantAudioOnly, targetHeight),
    },
    {
      name: "Piped/Invidious",
      resolve: () => resolveViaPipedAndInvidious(videoId, wantAudioOnly, targetHeight),
    },
    {
      name: "InnerTube",
      resolve: () => resolveViaInnerTubeDirect(videoId, wantAudioOnly, targetHeight),
    },
  ];
}

export async function resolveYoutubeStreamRace(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number
): Promise<ResolvedStream> {
  const errors: string[] = [];
  for (const cand of getYoutubeCandidateResolvers(videoId, wantAudioOnly, targetHeight)) {
    try {
      return await cand.resolve();
    } catch (err) {
      errors.push(`${cand.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All YouTube stream providers failed (${errors.join(" | ")})`);
}
