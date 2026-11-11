/**
 * Real server-side media stream download + FFmpeg trim/mux/conversion pipeline.
 * Runs in Node.js (Next.js App Router & Vercel Fluid Compute Serverless Functions).
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { chooseFormat, Quality } from "@distube/ytdl-core";
import { getSharedYtdl, resolveDirectStreamUrls } from "./realExtractor";
import { extractYoutubeVideoId } from "./sanitizer";
import { isHlsManifestUrl } from "./youtubeProviders";

const execFileAsync = promisify(execFile);

export const MEDIA_TMP_DIR = "/tmp/mediasphere_media";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function ensureTmpDir() {
  fs.mkdirSync(MEDIA_TMP_DIR, { recursive: true });
}

let cachedFfmpegBin: string | null = null;

export function resolveFfmpegBin(): string {
  if (cachedFfmpegBin && fs.existsSync(cachedFfmpegBin)) {
    return cachedFfmpegBin;
  }
  const installerPath = ffmpegInstaller?.path;
  if (installerPath && fs.existsSync(installerPath)) {
    try {
      fs.accessSync(installerPath, fs.constants.X_OK);
      cachedFfmpegBin = installerPath;
      return installerPath;
    } catch {
      const tmpBin = "/tmp/mediasphere_ffmpeg";
      if (!fs.existsSync(tmpBin)) {
        fs.copyFileSync(installerPath, tmpBin);
        fs.chmodSync(tmpBin, 0o755);
      }
      cachedFfmpegBin = tmpBin;
      return tmpBin;
    }
  }
  return "ffmpeg";
}

export interface ProgressCallbackPayload {
  progress: number;
  speedMbps: number;
  etaSeconds: number | null;
}

async function streamReadableToFile(
  readable: Readable,
  destPath: string,
  onProgress?: (p: ProgressCallbackPayload) => void,
  progressRange: [number, number] = [28, 74],
  totalBytes?: number | null
): Promise<void> {
  const started = Date.now();
  let bytes = 0;
  let lastReport = 0;
  readable.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    const now = Date.now();
    if (onProgress && now - lastReport >= 350) {
      lastReport = now;
      const elapsedSec = Math.max(0.1, (now - started) / 1000);
      const speedMbps = Number((bytes / (1024 * 1024) / elapsedSec).toFixed(1));
      const pct =
        totalBytes && totalBytes > 0
          ? Math.min(progressRange[1], progressRange[0] + (bytes / totalBytes) * (progressRange[1] - progressRange[0]))
          : Math.min(progressRange[1], progressRange[0] + Math.log1p(bytes / (512 * 1024)) * 11);
      const eta =
        totalBytes && totalBytes > bytes && speedMbps > 0
          ? Math.max(1, Math.round((totalBytes - bytes) / (1024 * 1024) / speedMbps))
          : 3;
      onProgress({ progress: Math.round(pct), speedMbps, etaSeconds: eta });
    }
  });
  await pipeline(readable, fs.createWriteStream(destPath));
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 256) {
    throw new Error("Downloaded stream was empty");
  }

  // Guard against HTML/JSON error responses saved to disk
  const fd = fs.openSync(destPath, "r");
  const head = Buffer.alloc(256);
  const readBytes = fs.readSync(fd, head, 0, 256, 0);
  fs.closeSync(fd);
  const sample = head.subarray(0, readBytes).toString("latin1").trimStart().toLowerCase();
  if (
    sample.startsWith("<!doctype") ||
    sample.startsWith("<html") ||
    sample.startsWith('{"error') ||
    sample.startsWith('{"status":false')
  ) {
    safeUnlink(destPath);
    throw new Error("Upstream CDN returned an error document instead of media bytes");
  }
}

async function downloadHttpUrlToFile(
  streamUrl: string,
  destPath: string,
  headers?: Record<string, string>,
  onProgress?: (p: ProgressCallbackPayload) => void,
  progressRange: [number, number] = [28, 74]
): Promise<void> {
  const res = await fetch(streamUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      ...(headers || {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Media stream HTTP ${res.status}`);
  }
  const totalLen = Number(res.headers.get("content-length") || 0) || null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeReadable = Readable.fromWeb(res.body as any);
  await streamReadableToFile(nodeReadable, destPath, onProgress, progressRange, totalLen);
}

async function downloadYoutubeYtdlFallback(
  url: string,
  filePrefix: string,
  resolution: string,
  format: string,
  onProgress?: (p: ProgressCallbackPayload) => void
): Promise<{ videoInput?: string; audioInput?: string }> {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) throw new Error("Invalid YouTube video ID");

  const wantAudioOnly = resolution === "audio" || format === "mp3" || format === "wav";
  const targetHeight = resolution === "best" ? 2160 : parseInt(resolution.replace(/\D/g, ""), 10) || 1080;

  const ytdl = getSharedYtdl();
  const info = await ytdl.getInfo(videoId, { signal: AbortSignal.timeout(12000) });

  if (wantAudioOnly) {
    const audioFmt = chooseFormat(info.formats, {
      quality: Quality.HighestAudio,
      filter: [{ hasAudio: true, hasVideo: false }, { hasAudio: true }],
    });
    const audioDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.${audioFmt.container || "m4a"}`);
    const stream = ytdl.download(info, {
      format: audioFmt,
      signal: AbortSignal.timeout(60000),
    });
    await streamReadableToFile(stream, audioDest, onProgress, [28, 74], audioFmt.contentLength);
    return { audioInput: audioDest };
  }

  const muxedCandidates = info.formats
    .filter((f) => f.hasVideo && f.hasAudio && !f.isHLS && (f.height || 360) <= targetHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (muxedCandidates[0]) {
    const vidDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_mux.${muxedCandidates[0].container || "mp4"}`);
    const stream = ytdl.download(info, {
      format: muxedCandidates[0],
      signal: AbortSignal.timeout(60000),
    });
    await streamReadableToFile(stream, vidDest, onProgress, [28, 74], muxedCandidates[0].contentLength);
    return { videoInput: vidDest };
  }

  const adaptiveVideo = info.formats
    .filter((f) => f.hasVideo && !f.isHLS && (f.height || 360) <= targetHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (!adaptiveVideo) {
    throw new Error("No downloadable video format returned by ytdl fallback");
  }
  const audioFmt = chooseFormat(info.formats, {
    quality: Quality.HighestAudio,
    filter: [{ hasAudio: true, hasVideo: false }, { hasAudio: true }],
  });
  const vidDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_vid.${adaptiveVideo.container || "mp4"}`);
  const audDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.${audioFmt.container || "m4a"}`);

  await Promise.all([
    streamReadableToFile(
      ytdl.download(info, { format: adaptiveVideo, signal: AbortSignal.timeout(60000) }),
      vidDest,
      onProgress,
      [28, 68],
      adaptiveVideo.contentLength
    ),
    streamReadableToFile(
      ytdl.download(info, { format: audioFmt, signal: AbortSignal.timeout(60000) }),
      audDest,
      undefined,
      [28, 68],
      audioFmt.contentLength
    ),
  ]);
  return { videoInput: vidDest, audioInput: audDest };
}

function formatFfmpegHeaderArg(headers?: Record<string, string>): string | null {
  if (!headers || Object.keys(headers).length === 0) return null;
  const lines = Object.entries(headers)
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}: ${v}\r\n`);
  return lines.length > 0 ? lines.join("") : null;
}

async function runFfmpegProcess(params: {
  videoInput?: string;
  audioInput?: string;
  inputHeaders?: Record<string, string>;
  outputPath: string;
  format: string;
  trimStart: string | null;
  trimEnd: string | null;
}): Promise<void> {
  const ffmpeg = resolveFfmpegBin();
  const headerBlock = formatFfmpegHeaderArg(params.inputHeaders);

  const buildInputArgs = (input: string) => {
    const out: string[] = [];
    const isRemote = /^https?:\/\//i.test(input);
    if (isRemote && headerBlock) {
      out.push("-headers", headerBlock);
    }
    if (params.trimStart) out.push("-ss", params.trimStart);
    if (params.trimEnd) out.push("-to", params.trimEnd);
    out.push("-i", input);
    return out;
  };

  const args: string[] = ["-y"];
  if (params.videoInput) {
    args.push(...buildInputArgs(params.videoInput));
  }
  if (params.audioInput) {
    args.push(...buildInputArgs(params.audioInput));
  }

  if (params.format === "mp3") {
    args.push("-vn", "-acodec", "libmp3lame", "-q:a", "2");
  } else if (params.format === "wav") {
    args.push("-vn", "-acodec", "pcm_s16le", "-ar", "44100");
  } else if (params.format === "webm") {
    if (params.videoInput && params.audioInput) {
      args.push("-map", "0:v:0", "-map", "1:a:0?");
    }
    args.push("-c:v", "libvpx", "-b:v", "1M", "-c:a", "libvorbis", "-shortest");
  } else {
    // mp4: fast stream-copy when possible, fallback to ultrafast H.264 + AAC
    if (params.videoInput && params.audioInput) {
      args.push("-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart");
    } else if (
      !params.trimStart &&
      !params.trimEnd &&
      params.videoInput &&
      !/^https?:\/\//i.test(params.videoInput)
    ) {
      args.push("-c", "copy", "-movflags", "+faststart");
    } else {
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart");
    }
  }

  args.push(params.outputPath);

  try {
    await execFileAsync(ffmpeg, args, { timeout: 110000, maxBuffer: 10 * 1024 * 1024 });
    if (fs.existsSync(params.outputPath) && fs.statSync(params.outputPath).size > 512) {
      return;
    }
    throw new Error("Initial FFmpeg pass produced empty output");
  } catch {
    // Fallback full transcode if stream-copy failed on codec/container mismatch
    const fallbackArgs: string[] = ["-y"];
    if (params.videoInput) fallbackArgs.push(...buildInputArgs(params.videoInput));
    if (params.audioInput) fallbackArgs.push(...buildInputArgs(params.audioInput));
    if (params.format === "mp3") {
      fallbackArgs.push("-vn", "-acodec", "libmp3lame", "-q:a", "2");
    } else if (params.format === "wav") {
      fallbackArgs.push("-vn", "-acodec", "pcm_s16le", "-ar", "44100");
    } else if (params.format === "webm") {
      fallbackArgs.push("-c:v", "libvpx", "-b:v", "1M", "-c:a", "libvorbis", "-shortest");
    } else {
      fallbackArgs.push(
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-shortest",
        "-movflags", "+faststart"
      );
    }
    fallbackArgs.push(params.outputPath);
    await execFileAsync(ffmpeg, fallbackArgs, { timeout: 110000, maxBuffer: 10 * 1024 * 1024 });
  }
}

function safeUnlink(p: string | undefined) {
  if (!p || /^https?:\/\//i.test(p)) return;
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export async function downloadAndProcessRealMedia(params: {
  fileKey: string;
  url: string;
  platform: string;
  resolution: string;
  format: string;
  trimStart: string | null;
  trimEnd: string | null;
  onProgress?: (p: ProgressCallbackPayload) => void;
}): Promise<{ filePath: string; fileSize: number }> {
  ensureTmpDir();
  const ext = ["mp4", "webm", "mp3", "wav"].includes(params.format) ? params.format : "mp4";
  const outputPath = path.join(MEDIA_TMP_DIR, `${params.fileKey}.${ext}`);

  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
    return { filePath: outputPath, fileSize: fs.statSync(outputPath).size };
  }

  let videoInput: string | undefined;
  let audioInput: string | undefined;
  let inputHeaders: Record<string, string> | undefined;

  try {
    params.onProgress?.({ progress: 26, speedMbps: 0, etaSeconds: 8 });
    const wantAudioOnly = params.resolution === "audio" || ext === "mp3" || ext === "wav";

    try {
      const direct = await resolveDirectStreamUrls(
        params.url,
        params.platform,
        params.resolution,
        ext
      );
      inputHeaders = direct.headers;

      const primaryStream = wantAudioOnly ? (direct.audioUrl || direct.videoUrl) : direct.videoUrl;
      if (!primaryStream) {
        throw new Error("Provider returned empty media URL");
      }

      if (direct.isHls || isHlsManifestUrl(primaryStream)) {
        // Let bundled FFmpeg demux & trim HLS segments directly
        params.onProgress?.({ progress: 52, speedMbps: 2.4, etaSeconds: 5 });
        if (wantAudioOnly) {
          audioInput = primaryStream;
        } else {
          videoInput = primaryStream;
          if (direct.audioUrl && direct.audioUrl !== primaryStream) {
            audioInput = direct.audioUrl;
          }
        }
      } else if (wantAudioOnly) {
        audioInput = path.join(MEDIA_TMP_DIR, `${params.fileKey}_aud.media`);
        await downloadHttpUrlToFile(primaryStream, audioInput, direct.headers, params.onProgress, [30, 74]);
      } else {
        videoInput = path.join(MEDIA_TMP_DIR, `${params.fileKey}_vid.mp4`);
        await downloadHttpUrlToFile(primaryStream, videoInput, direct.headers, params.onProgress, [30, 68]);
        if (direct.audioUrl) {
          const audTmp = path.join(MEDIA_TMP_DIR, `${params.fileKey}_aud.m4a`);
          try {
            await downloadHttpUrlToFile(direct.audioUrl, audTmp, direct.headers, undefined, [68, 74]);
            audioInput = audTmp;
          } catch {
            audioInput = undefined;
          }
        }
      }
    } catch (primaryErr) {
      // Extra fallback for YouTube via @distube/ytdl-core if all relay providers failed
      if (params.platform === "youtube") {
        try {
          const fb = await downloadYoutubeYtdlFallback(
            params.url,
            params.fileKey,
            params.resolution,
            ext,
            params.onProgress
          );
          videoInput = fb.videoInput;
          audioInput = fb.audioInput;
        } catch {
          throw primaryErr;
        }
      } else {
        throw primaryErr;
      }
    }

    params.onProgress?.({ progress: 78, speedMbps: 0, etaSeconds: 2 });

    await runFfmpegProcess({
      videoInput,
      audioInput,
      inputHeaders,
      outputPath,
      format: ext,
      trimStart: params.trimStart,
      trimEnd: params.trimEnd,
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 512) {
      throw new Error("FFmpeg output file was empty");
    }

    cleanupServerlessStorage();
    return { filePath: outputPath, fileSize: fs.statSync(outputPath).size };
  } finally {
    safeUnlink(videoInput);
    safeUnlink(audioInput);
  }
}

export function getCachedMediaPath(fileKey: string, format: string): string | null {
  const ext = ["mp4", "webm", "mp3", "wav"].includes(format) ? format : "mp4";
  const p = path.join(MEDIA_TMP_DIR, `${fileKey}.${ext}`);
  if (fs.existsSync(p) && fs.statSync(p).size > 512) {
    return p;
  }
  return null;
}

export function cleanupServerlessStorage(ttlMs = 15 * 60 * 1000) {
  try {
    if (!fs.existsSync(MEDIA_TMP_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(MEDIA_TMP_DIR)) {
      const full = path.join(MEDIA_TMP_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now - st.mtimeMs > ttlMs) {
          fs.unlinkSync(full);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
