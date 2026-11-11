/**
 * Multi-Engine Resilient Media Stream Resolver (2026 Datacenter / Serverless Ready).
 *
 * Why single-source YouTube extractors fail on Vercel/AWS:
 * - Direct YouTube InnerTube calls from AWS/cloud IPs frequently trigger `LOGIN_REQUIRED`
 *   ("Sign in to confirm you're not a bot"), and `WEB_EMBEDDED` is disabled on major-label
 *   music videos (e.g. Warner/UMG/SME official videos).
 * - Many legacy Piped/Invidious mirrors have disabled public stream proxying.
 *
 * Solution — Concurrent Provider Race + Byte-Level Stream Probing:
 * 1. SaveTube CDN Relay (`media.savetube.vip` AES-128-CBC v2 protocol) — residential worker pool
 * 2. CNV.CX / Y2Meta Converter Relay (`cnv.cx/v2` sanity-key protocol) — H.264 MP4 & 320k MP3
 * 3. Live Piped & Invidious Proxy Fleet (2026 verified instances + runtime registry discovery + HLS)
 * 4. Direct YouTube InnerTube (`VISIONOS` w/ visitorData, `ANDROID` 20.10, `youtubei.js` `ANDROID_VR`/`IOS`)
 * 5. CnvMP3 Converter Relay (`cnvmp3.com` — supports YouTube, TikTok, Instagram, X, Reddit, Twitch, Facebook)
 *
 * Every candidate URL is verified via a 64 KiB HTTP Range byte probe (rejecting HTML/JSON error
 * pages disguised as HTTP 200) before winning the race.
 */
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
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported stream protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function isHlsManifestUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url) || /\/api\/manifest\/hls/i.test(url);
}

/**
 * Probes the first <= 64 KiB of a candidate media URL and cancels immediately.
 * Prevents HTML/JSON error pages with HTTP 200 or 403-blocked googlevideo links from winning.
 */
export async function probeMediaStreamUrl(
  rawUrl: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  timeoutMs = 16000
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

  const res = await fetch(normalized, {
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
      throw new Error("Stream probe detected HTML/JSON error payload instead of media");
    }
    if (looksLikeHls) {
      throw new Error("Expected #EXTM3U HLS playlist but received non-HLS response");
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
// ENGINE 1: SAVETUBE RESIDENTIAL CDN RELAY (AES-128-CBC v2)
// ============================================================================

const SAVETUBE_CDN_DISCOVERY = "https://media.savetube.vip/api/random-cdn";
const SAVETUBE_ORIGIN = "https://save-tube.com";
const SAVETUBE_AES_KEY = Buffer.from("C5D58EF67A7584E4A29F6C35BBC4EB12", "hex");

interface SaveTubeFormat {
  quality?: number | string;
  height?: number | string;
  label?: string;
  url?: string | null;
}

interface SaveTubeMeta {
  id: string;
  key: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  video_formats?: SaveTubeFormat[];
  audio_formats?: SaveTubeFormat[];
}

function saveTubeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": DESKTOP_UA,
    Origin: SAVETUBE_ORIGIN,
    Referer: `${SAVETUBE_ORIGIN}/`,
    ...extra,
  };
}

async function getSaveTubeCdn(signal?: AbortSignal): Promise<string> {
  const res = await fetch(SAVETUBE_CDN_DISCOVERY, {
    headers: saveTubeHeaders({ Accept: "application/json" }),
    redirect: "follow",
    signal: combineSignal(signal, 8000),
  });
  if (!res.ok) throw new Error(`SaveTube CDN HTTP ${res.status}`);
  const data = (await res.json()) as { cdn?: string };
  if (!data?.cdn) throw new Error("SaveTube returned empty CDN");
  return data.cdn;
}

function decryptSaveTubePayload(encoded: string): SaveTubeMeta {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length <= 16) throw new Error("Invalid SaveTube encrypted payload");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = createDecipheriv("aes-128-cbc", SAVETUBE_AES_KEY, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as SaveTubeMeta;
}

export async function resolveViaSaveTube(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const cdn = await getSaveTubeCdn(signal);
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const infoRes = await fetch(`https://${cdn}/v2/info`, {
    method: "POST",
    headers: saveTubeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ url: watchUrl }),
    redirect: "follow",
    signal: combineSignal(signal, 16000),
  });
  const infoJson = (await infoRes.json().catch(() => null)) as { status?: boolean; data?: string } | null;
  if (!infoRes.ok || !infoJson?.status || !infoJson.data) {
    throw new Error(`SaveTube info HTTP ${infoRes.status}`);
  }

  const meta = decryptSaveTubePayload(infoJson.data);
  if (!meta.key) throw new Error("SaveTube missing conversion key");

  const dlCdn = await getSaveTubeCdn(signal).catch(() => cdn);
  const dlHeaders = saveTubeHeaders();

  if (wantAudioOnly) {
    const audioQualities = (meta.audio_formats || [])
      .map((f) => parseInt(String(f.quality ?? "128").replace(/\D/g, ""), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    const chosenQ = String(audioQualities[0] || 128);

    const dlRes = await fetch(`https://${dlCdn}/download`, {
      method: "POST",
      headers: saveTubeHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ downloadType: "audio", quality: chosenQ, key: meta.key }),
      redirect: "follow",
      signal: combineSignal(signal, 18000),
    });
    const dlJson = (await dlRes.json().catch(() => null)) as {
      status?: boolean;
      data?: { downloadUrl?: string };
    } | null;
    const link = dlJson?.data?.downloadUrl;
    if (!link) throw new Error("SaveTube audio link empty");

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const probed = await probeMediaStreamUrl(link, dlHeaders, signal, 14000);
        return { audioUrl: probed.url, headers: dlHeaders, isHls: probed.isHls, provider: "savetube" };
      } catch (err) {
        if (attempt === 3 || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, 1400));
      }
    }
  }

  // Video quality candidates (closest <= targetHeight first, then fallback qualities)
  const availableHeights = Array.from(
    new Set(
      (meta.video_formats || [])
        .map((f) => parseInt(String(f.quality ?? f.height ?? "").replace(/\D/g, ""), 10))
        .filter((n) => Number.isFinite(n) && n >= 144)
    )
  ).sort((a, b) => b - a);

  const leq = availableHeights.filter((h) => h <= targetHeight);
  const candidates = leq.length > 0 ? leq.slice(0, 2) : availableHeights.length > 0 ? [availableHeights[availableHeights.length - 1]] : [720, 360];

  let lastErr: unknown = null;
  for (const q of candidates) {
    try {
      const dlRes = await fetch(`https://${dlCdn}/download`, {
        method: "POST",
        headers: saveTubeHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ downloadType: "video", quality: String(q), key: meta.key }),
        redirect: "follow",
        signal: combineSignal(signal, 18000),
      });
      const dlJson = (await dlRes.json().catch(() => null)) as {
        status?: boolean;
        data?: { downloadUrl?: string };
      } | null;
      const link = dlJson?.data?.downloadUrl;
      if (!link) throw new Error(`SaveTube ${q}p link empty`);

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const probed = await probeMediaStreamUrl(link, dlHeaders, signal, 14000);
          return { videoUrl: probed.url, headers: dlHeaders, isHls: probed.isHls, provider: "savetube" };
        } catch (err) {
          if (attempt === 3 || signal?.aborted) throw err;
          await new Promise((r) => setTimeout(r, 1400));
        }
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("SaveTube video resolution failed");
}

// ============================================================================
// ENGINE 2: CNV.CX / Y2META CONVERTER RELAY
// ============================================================================

const CNVCX_ORIGIN = "https://frame.y2meta-uk.com";
const CNVCX_BASE = "https://cnv.cx/v2";

export async function resolveViaCnvCx(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const reqHeaders = {
    "User-Agent": DESKTOP_UA,
    Origin: CNVCX_ORIGIN,
    Referer: `${CNVCX_ORIGIN}/`,
  };

  const keyRes = await fetch(`${CNVCX_BASE}/sanity/key?id=${encodeURIComponent(videoId)}`, {
    headers: { ...reqHeaders, Accept: "application/json, text/plain, */*" },
    redirect: "follow",
    signal: combineSignal(signal, 14000),
  });
  const keyJson = (await keyRes.json().catch(() => null)) as { key?: string; errorMsg?: string } | null;
  if (!keyRes.ok || !keyJson?.key) {
    throw new Error(keyJson?.errorMsg || `CNV.CX key HTTP ${keyRes.status}`);
  }

  const qualities = wantAudioOnly
    ? [320]
    : Array.from(new Set([snapQuality(targetHeight, [1080, 720, 480, 360]), 720, 360])).slice(0, 2);

  let lastErr: unknown = null;
  for (const q of qualities) {
    try {
      const body = new URLSearchParams({
        link: `https://youtu.be/${videoId}`,
        format: wantAudioOnly ? "mp3" : "mp4",
        filenameStyle: "pretty",
        vCodec: "h264",
        audioBitrate: wantAudioOnly ? String(q) : "128",
        videoQuality: wantAudioOnly ? "720" : String(q),
      });

      const convRes = await fetch(`${CNVCX_BASE}/converter`, {
        method: "POST",
        headers: {
          ...reqHeaders,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "*/*",
          key: keyJson.key,
        },
        body: body.toString(),
        redirect: "follow",
        signal: combineSignal(signal, 45000),
      });
      const convJson = (await convRes.json().catch(() => null)) as {
        url?: string;
        errorMsg?: string;
        message?: string;
      } | null;
      if (!convRes.ok || !convJson?.url) {
        throw new Error(convJson?.errorMsg || convJson?.message || `CNV.CX convert HTTP ${convRes.status}`);
      }

      const probed = await probeMediaStreamUrl(convJson.url, reqHeaders, signal, 16000);
      if (wantAudioOnly) {
        return { audioUrl: probed.url, headers: reqHeaders, isHls: probed.isHls, provider: "cnvcx" };
      }
      return { videoUrl: probed.url, headers: reqHeaders, isHls: probed.isHls, provider: "cnvcx" };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("CNV.CX conversion failed");
}

// ============================================================================
// ENGINE 3: CNVMP3 MULTI-PLATFORM CONVERTER (YouTube, TikTok, IG, X, Reddit, FB)
// ============================================================================

const CNVMP3_BASE = "https://cnvmp3.com";
const CNVMP3_REFERER = `${CNVMP3_BASE}/v55`;

export async function resolveViaCnvMp3(
  sourceUrl: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  fallbackTitle = "media",
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const mediaHeaders = {
    "User-Agent": DESKTOP_UA,
    Referer: CNVMP3_REFERER,
  };

  let title = fallbackTitle;
  try {
    const infoRes = await fetch(`${CNVMP3_BASE}/get_video_data.php`, {
      method: "POST",
      headers: {
        ...mediaHeaders,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
      body: JSON.stringify({ url: sourceUrl, token: "1234" }),
      redirect: "follow",
      signal: combineSignal(signal, 18000),
    });
    const infoJson = (await infoRes.json().catch(() => null)) as { title?: string } | null;
    if (infoJson?.title && typeof infoJson.title === "string" && infoJson.title.trim()) {
      title = infoJson.title.trim();
    }
  } catch {
    /* proceed with fallback title */
  }

  const quality = wantAudioOnly ? 0 : snapQuality(targetHeight, [1080, 720, 480, 360]);
  const dlRes = await fetch(`${CNVMP3_BASE}/download_video_ucep.php`, {
    method: "POST",
    headers: {
      ...mediaHeaders,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify({
      url: sourceUrl,
      quality,
      title,
      formatValue: wantAudioOnly ? 1 : 0,
    }),
    redirect: "follow",
    signal: combineSignal(signal, 55000),
  });
  const dlJson = (await dlRes.json().catch(() => null)) as {
    download_link?: string;
    error?: string;
    message?: string;
  } | null;

  if (!dlRes.ok || !dlJson?.download_link) {
    throw new Error(dlJson?.error || dlJson?.message || `CnvMP3 HTTP ${dlRes.status}`);
  }

  const probed = await probeMediaStreamUrl(dlJson.download_link, mediaHeaders, signal, 18000);
  if (wantAudioOnly) {
    return { audioUrl: probed.url, headers: mediaHeaders, isHls: probed.isHls, provider: "cnvmp3" };
  }
  return { videoUrl: probed.url, headers: mediaHeaders, isHls: probed.isHls, provider: "cnvmp3" };
}

// ============================================================================
// ENGINE 4: LIVE PIPED & INVIDIOUS PROXY FLEET (2026 Verified + Dynamic Registry)
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
    fetch("https://piped-instances.kavin.rocks/", {
      headers: { "User-Agent": DESKTOP_UA },
      signal: combineSignal(signal, 4500),
    }).then((r) => (r.ok ? r.json() : [])),
    fetch("https://api.invidious.io/instances.json?sort_by=health", {
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
        const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
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
        const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
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
        const res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
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
// ENGINE 5: DIRECT YOUTUBE INNERTUBE (VISIONOS w/ visitorData + ANDROID_VR + IOS)
// ============================================================================

let cachedVisitorData: { token: string; at: number } | null = null;

async function fetchYoutubeVisitorData(signal?: AbortSignal): Promise<string | undefined> {
  if (cachedVisitorData && Date.now() - cachedVisitorData.at < 15 * 60 * 1000) {
    return cachedVisitorData.token;
  }
  try {
    const res = await fetch("https://www.youtube.com/sw.js_data", {
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
  // 5A: Direct VISIONOS 1.02 + visitorData (no JS cipher or PO token required)
  try {
    const visitorData = await fetchYoutubeVisitorData(signal);
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
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

  // 5B: youtubei.js ANDROID_VR / IOS
  try {
    const yt = await Innertube.create({ retrieve_player: false });
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
// MASTER YOUTUBE PROVIDER RACE
// ============================================================================

export async function resolveYoutubeStreamRace(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  fallbackTitle = "youtube_media"
): Promise<ResolvedStream> {
  const raceAbort = new AbortController();
  const errors: string[] = [];

  const wrap = (name: string, fn: (sig: AbortSignal) => Promise<ResolvedStream>) =>
    fn(raceAbort.signal).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      throw err;
    });

  // Tier 1: Concurrent fast race across SaveTube CDN, CNV.CX, Live Piped/Invidious, and Direct InnerTube
  try {
    const winner = await Promise.any([
      wrap("SaveTube", (sig) => resolveViaSaveTube(videoId, wantAudioOnly, targetHeight, sig)),
      wrap("CNV.CX", (sig) => resolveViaCnvCx(videoId, wantAudioOnly, targetHeight, sig)),
      wrap("Piped/Invidious", (sig) => resolveViaPipedAndInvidious(videoId, wantAudioOnly, targetHeight, sig)),
      wrap("InnerTube", (sig) => resolveViaInnerTubeDirect(videoId, wantAudioOnly, targetHeight, sig)),
    ]);
    raceAbort.abort();
    return winner;
  } catch {
    raceAbort.abort();
  }

  // Tier 2: CnvMP3 server-side transcode fallback
  try {
    return await resolveViaCnvMp3(
      `https://www.youtube.com/watch?v=${videoId}`,
      wantAudioOnly,
      targetHeight,
      fallbackTitle
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`CnvMP3: ${msg}`);
  }

  throw new Error(`All YouTube stream providers failed (${errors.join(" | ")})`);
}
