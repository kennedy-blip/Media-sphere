/**
 * Multi-Engine Cloud-Resilient YouTube & Media Stream Resolver (Vercel / AWS Datacenter Ready).
 *
 * Ordered Failover Chain (each verified end-to-end through byte download in `realProcessor.ts`):
 * 1. SaveTube Single-Node Clean Protocol (`media.savetube.vip/api/random-cdn` -> fresh `/v2/info` ->
 *    `/download` on the SAME CDN node, zero parallel node bursts to avoid SaveTube's per-video Redis
 *    "This video is busy right now" lock, using fast pre-muxed 720p/360p + 4s pending retry).
 * 2. SaveNow / Y2Down Official Client API (`p.savenow.to` / `p.oceansaver.in` w/ client API key,
 *    supporting full 1080p, 720p, 480p, 360p, MP3, WAV via `progress_url` polling).
 * 3. YTConvert Cloud API (`hub.ytconvert.org` / `api.ytconvert.org` w/ `statusUrl` polling).
 * 4. YTDown Proxy API (`app.ytdown.to/proxy.php` two-step `mediaItems` -> `fileUrl`).
 * 5. Cloud Relay Race (`eliteprotech-apis.zone.id`, `api.yupra.my.id`, `okatsu-rolezapiiz.vercel.app`).
 * 6. Live 2026 Piped & Invidious Proxy Fleet (MP4, adaptive mux, and `.m3u8` HLS).
 * 7. Direct YouTube InnerTube (`VISIONOS` 1.02 w/ `visitorData`, `youtubei.js` `ANDROID_VR`/`IOS`).
 */
import { createDecipheriv } from "crypto";
import { Innertube, ClientType } from "youtubei.js";

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_YT_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14)";
const VISIONOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

export interface ResolvedStream {
  videoUrl?: string;
  audioUrl?: string;
  headers?: Record<string, string>;
  isHls?: boolean;
  provider: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * Probes the first <= 64 KiB of multi-use streams (googlevideo / Piped / Invidious)
 * to reject IP-blocked 403s or HTML error pages immediately.
 */
export async function probeMediaStreamUrl(
  rawUrl: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  timeoutMs = 10000
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
// ENGINE 1: SAVETUBE SINGLE-NODE PROTOCOL (NO PARALLEL SELF-LOCKING)
// ============================================================================

const SAVETUBE_AES_KEY = Buffer.from("C5D58EF67A7584E4A29F6C35BBC4EB12", "hex");

const SAVETUBE_API_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Content-Type": "application/json",
  Origin: "https://yt.savetube.me",
  Referer: "https://yt.savetube.me/",
  "User-Agent": ANDROID_CHROME_UA,
};

const SAVETUBE_MEDIA_HEADERS: Record<string, string> = {
  Referer: "https://yt.savetube.me/",
  "User-Agent": ANDROID_CHROME_UA,
};

interface SaveTubeMeta {
  id?: string;
  key: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
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

async function resolveSingleSaveTubeCdn(signal?: AbortSignal): Promise<string> {
  const endpoints = [
    "https://media.savetube.vip/api/random-cdn",
    "https://media.savetube.me/api/random-cdn",
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: SAVETUBE_API_HEADERS,
        redirect: "follow",
        signal: combineSignal(signal, 6000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { cdn?: string; data?: { cdn?: string } };
      const cdn = json?.cdn || json?.data?.cdn;
      if (cdn && typeof cdn === "string") return cdn.trim();
    } catch {
      /* try next endpoint */
    }
  }
  return "cdn403.savetube.vip";
}

async function saveTubeSingleAttempt(
  cdn: string,
  videoId: string,
  downloadType: "video" | "audio",
  quality: string,
  signal?: AbortSignal
): Promise<string> {
  // Always mint a fresh info.key right before /download on the SAME CDN node
  const infoRes = await fetch(`https://${cdn}/v2/info`, {
    method: "POST",
    headers: SAVETUBE_API_HEADERS,
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
    redirect: "follow",
    signal: combineSignal(signal, 15000),
  });
  const infoJson = (await infoRes.json().catch(() => null)) as {
    data?: string;
    message?: string;
  } | null;
  if (!infoRes.ok || !infoJson?.data) {
    throw new Error(infoJson?.message || `SaveTube ${cdn} info HTTP ${infoRes.status}`);
  }
  const info = decryptSaveTubePayload(infoJson.data);
  if (!info?.key) {
    throw new Error(`SaveTube ${cdn} returned no key`);
  }

  const dlRes = await fetch(`https://${cdn}/download`, {
    method: "POST",
    headers: SAVETUBE_API_HEADERS,
    body: JSON.stringify({
      id: info.id || videoId,
      downloadType,
      quality,
      key: info.key,
    }),
    redirect: "follow",
    signal: combineSignal(signal, 25000),
  });
  const dlJson = (await dlRes.json().catch(() => null)) as {
    downloadUrl?: string;
    data?: { downloadUrl?: string; download_url?: string };
    message?: string;
  } | null;
  const link = dlJson?.data?.downloadUrl || dlJson?.data?.download_url || dlJson?.downloadUrl;
  if (!link || typeof link !== "string") {
    throw new Error(dlJson?.message || `SaveTube ${cdn} ${quality} returned no downloadUrl`);
  }
  return normalizeHttpUrl(link);
}

export async function resolveViaSaveTube(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  // Use 720p max on SaveTube because 720p/360p are pre-muxed (<2s), whereas 1080p adaptive
  // muxing triggers SaveTube's 60s per-video Redis lock ("This video is busy right now").
  // Engine 2 (SaveNow) & Engine 3 (YTConvert) handle full 1080p cleanly when SaveTube is busy.
  const downloadType: "video" | "audio" = wantAudioOnly ? "audio" : "video";
  const quality = wantAudioOnly
    ? "128"
    : String(snapQuality(Math.min(targetHeight, 720), [720, 480, 360]));

  const cdn = await resolveSingleSaveTubeCdn(signal);

  try {
    const link = await saveTubeSingleAttempt(cdn, videoId, downloadType, quality, signal);
    return wantAudioOnly
      ? { audioUrl: link, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}` }
      : { videoUrl: link, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}:${quality}p` };
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (/busy|try again|processing|failed to get download url/i.test(msg)) {
      // Wait briefly for the node's in-flight task to finish and poll ONCE with a fresh key
      await sleep(4500);
      const retryLink = await saveTubeSingleAttempt(cdn, videoId, downloadType, quality, signal);
      return wantAudioOnly
        ? { audioUrl: retryLink, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}` }
        : { videoUrl: retryLink, headers: SAVETUBE_MEDIA_HEADERS, provider: `savetube:${cdn}:${quality}p` };
    }
    throw firstErr;
  }
}

// ============================================================================
// ENGINE 2: SAVENOW / Y2DOWN CLIENT API (`p.savenow.to` / `p.oceansaver.in`)
// ============================================================================

const SAVENOW_BASES = ["https://p.savenow.to", "https://p.oceansaver.in"];
const SAVENOW_CLIENT_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_HEADERS: Record<string, string> = {
  "User-Agent": DESKTOP_UA,
  Referer: "https://y2down.cc/",
  Origin: "https://y2down.cc",
  Accept: "application/json, text/plain, */*",
};

export async function resolveViaSaveNow(
  videoIdOrUrl: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const watchUrl = videoIdOrUrl.startsWith("http")
    ? videoIdOrUrl
    : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;
  const fmt = wantAudioOnly ? "mp3" : String(snapQuality(targetHeight, [1080, 720, 480, 360]));

  let lastErr: unknown = null;

  for (const base of SAVENOW_BASES) {
    try {
      const initUrl = new URL(`${base}/ajax/download.php`);
      initUrl.searchParams.set("copyright", "0");
      initUrl.searchParams.set("format", fmt);
      initUrl.searchParams.set("url", watchUrl);
      initUrl.searchParams.set("api", SAVENOW_CLIENT_KEY);

      const res = await fetch(initUrl.toString(), {
        headers: SAVENOW_HEADERS,
        redirect: "follow",
        signal: combineSignal(signal, 12000),
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        id?: string;
        progress_url?: string;
        message?: string;
      } | null;

      const progressUrl =
        data?.progress_url ||
        (data?.id ? `${base}/api/progress?id=${encodeURIComponent(data.id)}` : null);

      if (!res.ok || !progressUrl) {
        throw new Error(data?.message || `SaveNow ${base} init HTTP ${res.status}`);
      }

      // Poll progress_url every 2s up to 14 times (~28s max)
      for (let i = 0; i < 14; i++) {
        if (i > 0) await sleep(2000);
        const pollRes = await fetch(progressUrl, {
          headers: SAVENOW_HEADERS,
          redirect: "follow",
          signal: combineSignal(signal, 8000),
        });
        if (!pollRes.ok) continue;
        const pollData = (await pollRes.json().catch(() => null)) as {
          success?: number;
          progress?: number;
          download_url?: string;
          text?: string;
        } | null;

        if (pollData?.download_url && pollData.download_url.startsWith("http")) {
          const dl = normalizeHttpUrl(pollData.download_url);
          const mediaHeaders = { "User-Agent": DESKTOP_UA, Referer: "https://y2down.cc/" };
          return wantAudioOnly
            ? { audioUrl: dl, headers: mediaHeaders, provider: "savenow:mp3" }
            : { videoUrl: dl, headers: mediaHeaders, provider: `savenow:${fmt}p` };
        }

        if (pollData?.text && /error|fail|unavailable|restricted/i.test(pollData.text)) {
          throw new Error(`SaveNow: ${pollData.text}`);
        }
      }

      throw new Error(`SaveNow ${base} timed out waiting for conversion`);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("SaveNow failed");
}

// ============================================================================
// ENGINE 3: YTCONVERT CLOUD API (`hub.ytconvert.org` / `api.ytconvert.org`)
// ============================================================================

const YTCONVERT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Android 14; Mobile)",
  Origin: "https://ytmp3.gg",
  Referer: "https://ytmp3.gg/",
};

export async function resolveViaYtConvert(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const quality = wantAudioOnly
    ? "128kbps"
    : `${snapQuality(targetHeight, [1080, 720, 480, 360])}p`;

  const payload = {
    url: watchUrl,
    os: "android",
    output: wantAudioOnly
      ? { type: "audio", format: "mp3", quality }
      : { type: "video", format: "mp4", quality },
  };

  let statusUrl: string | undefined;
  let initErr: unknown = null;

  for (const endpoint of [
    "https://hub.ytconvert.org/api/download",
    "https://api.ytconvert.org/api/download",
  ]) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: YTCONVERT_HEADERS,
        body: JSON.stringify(payload),
        redirect: "follow",
        signal: combineSignal(signal, 10000),
      });
      const json = (await res.json().catch(() => null)) as {
        statusUrl?: string;
        downloadUrl?: string;
        message?: string;
      } | null;

      if (json?.downloadUrl && json.downloadUrl.startsWith("http")) {
        const dl = normalizeHttpUrl(json.downloadUrl);
        return wantAudioOnly
          ? { audioUrl: dl, headers: { "User-Agent": DESKTOP_UA, Referer: "https://ytmp3.gg/" }, provider: "ytconvert" }
          : { videoUrl: dl, headers: { "User-Agent": DESKTOP_UA, Referer: "https://ytmp3.gg/" }, provider: `ytconvert:${quality}` };
      }

      if (res.ok && json?.statusUrl) {
        statusUrl = json.statusUrl;
        break;
      }
      initErr = new Error(json?.message || `YTConvert HTTP ${res.status}`);
    } catch (err) {
      initErr = err;
    }
  }

  if (!statusUrl) {
    throw initErr instanceof Error ? initErr : new Error("YTConvert init failed");
  }

  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const pollRes = await fetch(statusUrl, {
      headers: YTCONVERT_HEADERS,
      redirect: "follow",
      signal: combineSignal(signal, 8000),
    });
    if (!pollRes.ok) continue;
    const pollData = (await pollRes.json().catch(() => null)) as {
      status?: string;
      downloadUrl?: string;
      message?: string;
    } | null;

    if (pollData?.status === "completed" && pollData.downloadUrl) {
      const dl = normalizeHttpUrl(pollData.downloadUrl);
      const mediaHeaders = { "User-Agent": DESKTOP_UA, Referer: "https://ytmp3.gg/" };
      return wantAudioOnly
        ? { audioUrl: dl, headers: mediaHeaders, provider: "ytconvert" }
        : { videoUrl: dl, headers: mediaHeaders, provider: `ytconvert:${quality}` };
    }
    if (pollData?.status === "failed") {
      throw new Error(pollData.message || "YTConvert conversion failed");
    }
  }

  throw new Error("YTConvert poll timeout");
}

// ============================================================================
// ENGINE 4: YTDOWN PROXY API (`app.ytdown.to/proxy.php`)
// ============================================================================

const YTDOWN_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Referer: "https://app.ytdown.to/id21/",
  Origin: "https://app.ytdown.to",
  "User-Agent": DESKTOP_UA,
};

interface YtDownMediaItem {
  type?: string;
  mediaQuality?: string;
  mediaUrl?: string;
  mediaExtension?: string;
}

export async function resolveViaYtDown(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch("https://app.ytdown.to/proxy.php", {
    method: "POST",
    headers: YTDOWN_HEADERS,
    body: new URLSearchParams({ url: watchUrl }).toString(),
    redirect: "follow",
    signal: combineSignal(signal, 12000),
  });

  const data = (await res.json().catch(() => null)) as {
    api?: {
      status?: string;
      mediaItems?: YtDownMediaItem[];
    };
  } | null;

  if (!res.ok || data?.api?.status !== "ok" || !Array.isArray(data?.api?.mediaItems)) {
    throw new Error(`YTDown HTTP ${res.status}`);
  }

  const items = data.api.mediaItems.filter((i) => typeof i.mediaUrl === "string" && i.mediaUrl);
  let candidates: YtDownMediaItem[] = [];

  if (wantAudioOnly) {
    candidates = items.filter((i) => /audio/i.test(i.type || ""));
  } else {
    const vids = items
      .filter((i) => /video/i.test(i.type || ""))
      .map((item) => {
        const q = (item.mediaQuality || "").toLowerCase();
        const height = q.includes("1080") || q.includes("fhd")
          ? 1080
          : q.includes("720") || q.includes("hd")
            ? 720
            : q.includes("480")
              ? 480
              : q.includes("360") || q.includes("sd")
                ? 360
                : 480;
        return { item, height };
      })
      .sort((a, b) => b.height - a.height);

    const fitting = vids.filter((v) => v.height <= targetHeight).map((v) => v.item);
    candidates = fitting.length > 0 ? fitting : vids.map((v) => v.item);
  }

  for (const cand of candidates.slice(0, 2)) {
    const convRes = await fetch("https://app.ytdown.to/proxy.php", {
      method: "POST",
      headers: YTDOWN_HEADERS,
      body: new URLSearchParams({ url: cand.mediaUrl! }).toString(),
      redirect: "follow",
      signal: combineSignal(signal, 15000),
    });
    if (!convRes.ok) continue;
    const convJson = (await convRes.json().catch(() => null)) as {
      api?: { status?: string; fileUrl?: string };
    } | null;
    if (convJson?.api?.fileUrl && convJson.api.fileUrl.startsWith("http")) {
      const dl = normalizeHttpUrl(convJson.api.fileUrl);
      const mediaHeaders = { "User-Agent": DESKTOP_UA, Referer: "https://app.ytdown.to/" };
      return wantAudioOnly
        ? { audioUrl: dl, headers: mediaHeaders, provider: "ytdown:audio" }
        : { videoUrl: dl, headers: mediaHeaders, provider: "ytdown:video" };
    }
  }

  throw new Error("YTDown returned no completed fileUrl");
}

// ============================================================================
// ENGINE 5: CLOUD JSON RELAY RACE (EliteProTech + Yupra + Okatsu Vercel)
// ============================================================================

export async function resolveViaCloudRelays(
  videoId: string,
  wantAudioOnly: boolean,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const headers = { "User-Agent": DESKTOP_UA, Accept: "application/json, text/plain, */*" };

  const tasks: Array<Promise<ResolvedStream>> = [
    // 1. EliteProTech
    (async () => {
      const fmt = wantAudioOnly ? "mp3" : "mp4";
      const res = await fetch(
        `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(watchUrl)}&format=${fmt}`,
        { headers, redirect: "follow", signal: combineSignal(signal, 18000) }
      );
      if (!res.ok) throw new Error(`EliteProTech HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        downloadURL?: string;
        download_url?: string;
      };
      const link = json?.downloadURL || json?.download_url;
      if (!link) throw new Error("EliteProTech empty link");
      const dl = normalizeHttpUrl(link);
      return wantAudioOnly
        ? { audioUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "eliteprotech" }
        : { videoUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "eliteprotech" };
    })(),

    // 2. Yupra API
    (async () => {
      const ep = wantAudioOnly ? "ytmp3" : "ytmp4";
      const res = await fetch(
        `https://api.yupra.my.id/api/downloader/${ep}?url=${encodeURIComponent(watchUrl)}`,
        { headers, redirect: "follow", signal: combineSignal(signal, 18000) }
      );
      if (!res.ok) throw new Error(`Yupra HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { download_url?: string; url?: string };
        result?: { download_url?: string; url?: string };
      };
      const link =
        json?.data?.download_url ||
        json?.data?.url ||
        json?.result?.download_url ||
        json?.result?.url;
      if (!link) throw new Error("Yupra empty link");
      const dl = normalizeHttpUrl(link);
      return wantAudioOnly
        ? { audioUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "yupra" }
        : { videoUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "yupra" };
    })(),

    // 3. Okatsu Vercel API
    (async () => {
      const ep = wantAudioOnly ? "ytmp3" : "ytmp4";
      const res = await fetch(
        `https://okatsu-rolezapiiz.vercel.app/downloader/${ep}?url=${encodeURIComponent(watchUrl)}`,
        { headers, redirect: "follow", signal: combineSignal(signal, 18000) }
      );
      if (!res.ok) throw new Error(`Okatsu HTTP ${res.status}`);
      const json = (await res.json()) as {
        result?: { mp4?: string; mp3?: string; dl?: string; url?: string };
      };
      const link = json?.result?.mp4 || json?.result?.mp3 || json?.result?.dl || json?.result?.url;
      if (!link) throw new Error("Okatsu empty link");
      const dl = normalizeHttpUrl(link);
      return wantAudioOnly
        ? { audioUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "okatsu" }
        : { videoUrl: dl, headers: { "User-Agent": DESKTOP_UA }, provider: "okatsu" };
    })(),
  ];

  return await Promise.any(tasks);
}

// Retain VidsSave helper for non-YouTube social fallback compatibility
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

  const res = await fetch("https://api.vidssave.com/api/contentsite_api/media/parse", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/plain, */*",
      Origin: "https://vidssave.com",
      Referer: "https://vidssave.com/",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": DESKTOP_UA,
    },
    body: body.toString(),
    redirect: "follow",
    signal: combineSignal(signal, 12000),
  });

  const json = (await res.json().catch(() => null)) as {
    status?: number;
    msg?: string;
    message?: string;
    data?: {
      resources?: Array<{
        type?: string;
        quality?: string | number;
        download_url?: string;
      }>;
    };
  } | null;

  const resources = (json?.data?.resources || []).filter(
    (r) => typeof r.download_url === "string" && r.download_url.startsWith("http")
  );
  if (!res.ok || !resources.length) {
    throw new Error(json?.msg || json?.message || `VidsSave status=${json?.status ?? res.status}`);
  }

  const dlHeaders = { Referer: "https://vidssave.com/", "User-Agent": DESKTOP_UA };
  if (wantAudioOnly) {
    const aud = resources.find((r) => r.type === "audio") || resources[0];
    return { audioUrl: normalizeHttpUrl(aud.download_url!), headers: dlHeaders, provider: "vidssave" };
  }
  const vids = resources
    .filter((r) => r.type === "video")
    .map((r) => ({
      url: r.download_url!,
      height: parseInt(String(r.quality ?? "720").replace(/\D/g, ""), 10) || 720,
    }))
    .sort((a, b) => b.height - a.height);
  const chosen = vids.find((v) => v.height <= targetHeight) || vids[vids.length - 1] || { url: resources[0].download_url!, height: 720 };
  return { videoUrl: normalizeHttpUrl(chosen.url), headers: dlHeaders, provider: `vidssave:${chosen.height}p` };
}

// ============================================================================
// ENGINE 6: LIVE PIPED & INVIDIOUS PROXY FLEET (2026 Verified + Dynamic Registry)
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
          signal: combineSignal(signal, 7500),
        });
        if (!res.ok) throw new Error(`Piped ${base} HTTP ${res.status}`);
        const data = (await res.json()) as LivePipedData;

        const bestAudio = [...(data.audioStreams || [])]
          .filter((a) => a.url && !/lbry|odysee/i.test(a.url))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

        if (wantAudioOnly) {
          if (bestAudio?.url) {
            const p = await probeMediaStreamUrl(bestAudio.url, {}, signal, 8000);
            return { audioUrl: p.url, isHls: p.isHls, provider: `piped:${base}` };
          }
          if (data.hls) {
            const p = await probeMediaStreamUrl(data.hls, {}, signal, 8000);
            return { audioUrl: p.url, isHls: true, provider: `piped-hls:${base}` };
          }
          throw new Error("No Piped audio stream");
        }

        const muxed = [...(data.videoStreams || [])]
          .filter((v) => v.url && !v.videoOnly && !/lbry|odysee/i.test(v.url) && (v.height || 720) <= targetHeight)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (muxed?.url) {
          const p = await probeMediaStreamUrl(muxed.url, {}, signal, 8000);
          return { videoUrl: p.url, isHls: p.isHls, provider: `piped:${base}` };
        }

        const adaptiveVid = [...(data.videoStreams || [])]
          .filter((v) => v.url && !/lbry|odysee/i.test(v.url) && (v.height || 1080) <= targetHeight)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (adaptiveVid?.url && bestAudio?.url) {
          const [pv, pa] = await Promise.all([
            probeMediaStreamUrl(adaptiveVid.url, {}, signal, 8000),
            probeMediaStreamUrl(bestAudio.url, {}, signal, 8000),
          ]);
          return { videoUrl: pv.url, audioUrl: pa.url, isHls: pv.isHls, provider: `piped-mux:${base}` };
        }

        if (data.hls) {
          const p = await probeMediaStreamUrl(data.hls, {}, signal, 8000);
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
          signal: combineSignal(signal, 7500),
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
          const p = await probeMediaStreamUrl(link, {}, signal, 8000);
          return { audioUrl: p.url, isHls: p.isHls, provider: `invidious:${base}` };
        }
        const mux = (data.formatStreams || [])[0];
        if (!mux?.itag) throw new Error("No Invidious muxed itag");
        const link = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=${mux.itag}&local=true`;
        const p = await probeMediaStreamUrl(link, {}, signal, 8000);
        return { videoUrl: p.url, isHls: p.isHls, provider: `invidious:${base}` };
      })()
    );
  }

  if (!tasks.length) throw new Error("No Piped/Invidious instances available");
  return await Promise.any(tasks);
}

// ============================================================================
// ENGINE 7: DIRECT YOUTUBE INNERTUBE (VISIONOS w/ visitorData + ANDROID_VR + IOS)
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
      signal: combineSignal(signal, 7500),
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
            const p = await probeMediaStreamUrl(aud.url, headers, signal, 7500);
            return { audioUrl: p.url, headers, isHls: p.isHls, provider: "innertube:visionos" };
          }
        } else {
          const mux = [...(sd.formats || [])]
            .filter((f) => f.url && (f.height || 360) <= targetHeight)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (mux?.url) {
            const p = await probeMediaStreamUrl(mux.url, headers, signal, 7500);
            return { videoUrl: p.url, headers, isHls: p.isHls, provider: "innertube:visionos" };
          }
          if (sd.hlsManifestUrl) {
            const p = await probeMediaStreamUrl(sd.hlsManifestUrl, headers, signal, 7500);
            return { videoUrl: p.url, headers, isHls: true, provider: "innertube:visionos-hls" };
          }
        }
      }
    }
  } catch {
    /* try next client */
  }

  try {
    const yt = await Innertube.create({ retrieve_player: false });
    for (const client of [ClientType.ANDROID_VR, ClientType.IOS]) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = await yt.getBasicInfo(videoId, { client: client as any });
        const sd = info.streaming_data;
        if (!sd) continue;
        const ua = client === ClientType.ANDROID_VR ? ANDROID_YT_UA : VISIONOS_UA;
        const headers = { "User-Agent": ua };

        if (wantAudioOnly) {
          const aud = [...(sd.adaptive_formats || [])]
            .filter((f) => f.url && f.has_audio && !f.has_video)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (aud?.url) {
            const p = await probeMediaStreamUrl(aud.url, headers, signal, 7500);
            return { audioUrl: p.url, headers, isHls: p.isHls, provider: `youtubei:${client}` };
          }
        } else {
          const mux = [...(sd.formats || [])]
            .filter((f) => f.url && f.has_video && f.has_audio && (f.height || 360) <= targetHeight)
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (mux?.url) {
            const p = await probeMediaStreamUrl(mux.url, headers, signal, 7500);
            return { videoUrl: p.url, headers, isHls: p.isHls, provider: `youtubei:${client}` };
          }
          if (sd.hls_manifest_url) {
            const p = await probeMediaStreamUrl(sd.hls_manifest_url, headers, signal, 7500);
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
// ENGINE 0: COBALT COMMUNITY FLEET
// ============================================================================

/**
 * Cobalt is purpose-built for datacenter/serverless downloaders and returns a
 * tunnel URL whose bytes are proxied by the instance, avoiding YouTube's AWS
 * IP bot challenge. Instances are raced because community uptime varies.
 */
export async function resolveViaCobalt(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStream> {
  const instances = [
    "https://nuko-c.meowing.de",
    "https://cobalt-backend.canine.tools",
    "https://cobalt-api.clxxped.lol",
    "https://subito-c.meowing.de",
    "https://kityune.imput.net",
    "https://sunny.imput.net",
    "https://nachos.imput.net",
    "https://blossom.imput.net",
    "https://cobalt-api.meowing.de",
    "https://capi.3kh0.net",
  ];
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const quality = String(snapQuality(targetHeight, [2160, 1440, 1080, 720, 480, 360, 240, 144]));

  const attempt = async (base: string): Promise<ResolvedStream> => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": DESKTOP_UA,
      },
      body: JSON.stringify({
        url: watchUrl,
        videoQuality: quality,
        audioFormat: "mp3",
        audioBitrate: "128",
        downloadMode: wantAudioOnly ? "audio" : "auto",
        youtubeVideoCodec: "h264",
        filenameStyle: "pretty",
      }),
      redirect: "follow",
      signal: combineSignal(signal, 22000),
    });
    const json = (await res.json().catch(() => null)) as {
      status?: string;
      url?: string;
      error?: { code?: string } | string;
      picker?: Array<{ type?: string; url?: string }>;
    } | null;
    if (!res.ok) throw new Error(`${new URL(base).hostname} HTTP ${res.status}`);
    if (json?.status === "error") {
      const detail = typeof json.error === "string" ? json.error : json.error?.code;
      throw new Error(`${new URL(base).hostname}: ${detail || "Cobalt error"}`);
    }
    const pickerLink = json?.picker?.find((item) => item.type === "video" && item.url)?.url;
    const link = json?.url || pickerLink;
    if (!link) throw new Error(`${new URL(base).hostname} returned no tunnel URL`);
    const normalized = normalizeHttpUrl(link);
    const mediaHeaders = { "User-Agent": DESKTOP_UA, Accept: "*/*" };
    return wantAudioOnly
      ? { audioUrl: normalized, headers: mediaHeaders, provider: `cobalt:${new URL(base).hostname}` }
      : { videoUrl: normalized, headers: mediaHeaders, provider: `cobalt:${new URL(base).hostname}:${quality}p` };
  };

  // Race small groups to get low latency without flooding every public instance.
  const errors: string[] = [];
  for (let i = 0; i < instances.length; i += 3) {
    try {
      return await Promise.any(instances.slice(i, i + 3).map(attempt));
    } catch (err) {
      if (err instanceof AggregateError) {
        errors.push(...err.errors.map((e) => (e instanceof Error ? e.message : String(e))));
      } else {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  throw new Error(errors.slice(-5).join("; ") || "All Cobalt instances failed");
}

// ============================================================================
// ORDERED CANDIDATE LIST FOR DOWNLOAD-TIME FAILOVER
// ============================================================================

export function getYoutubeCandidateResolvers(
  videoId: string,
  wantAudioOnly: boolean,
  targetHeight: number
): Array<{ name: string; resolve: () => Promise<ResolvedStream> }> {
  // When user explicitly asks for 1080p+, put SaveNow (native 1080p) right after SaveTube (or first if 1080p)
  // Actually: SaveTube 720p is ~1.5s when unlocked, whereas SaveNow 1080p takes ~4-8s polling.
  // If targetHeight >= 1080, try SaveNow FIRST for true 1080p, then SaveTube 720p, then YTConvert 1080p, YTDown, CloudRelays!
  const preferFullHd = !wantAudioOnly && targetHeight >= 1080;

  const saveTubeEntry = {
    name: "SaveTube",
    resolve: () => resolveViaSaveTube(videoId, wantAudioOnly, targetHeight),
  };
  const saveNowEntry = {
    name: "SaveNow",
    resolve: () => resolveViaSaveNow(videoId, wantAudioOnly, targetHeight),
  };

  return [
    {
      name: "Cobalt",
      resolve: () => resolveViaCobalt(videoId, wantAudioOnly, targetHeight),
    },
    ...(preferFullHd ? [saveNowEntry, saveTubeEntry] : [saveTubeEntry, saveNowEntry]),
    {
      name: "YTConvert",
      resolve: () => resolveViaYtConvert(videoId, wantAudioOnly, targetHeight),
    },
    {
      name: "YTDown",
      resolve: () => resolveViaYtDown(videoId, wantAudioOnly, targetHeight),
    },
    {
      name: "CloudRelays",
      resolve: () => resolveViaCloudRelays(videoId, wantAudioOnly),
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
