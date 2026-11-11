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
  progressRange: [number, number] = [25, 72]
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
      const pct = Math.min(
        progressRange[1],
        progressRange[0] + Math.log1p(bytes / (512 * 1024)) * 11
      );
      onProgress({ progress: Math.round(pct), speedMbps, etaSeconds: 3 });
    }
  });
  await pipeline(readable, fs.createWriteStream(destPath));
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 256) {
    throw new Error("Downloaded stream was empty");
  }
}

async function downloadHttpUrlToFile(
  streamUrl: string,
  destPath: string,
  headers?: Record<string, string>,
  onProgress?: (p: ProgressCallbackPayload) => void,
  progressRange: [number, number] = [25, 72]
): Promise<void> {
  const res = await fetch(streamUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "*/*",
      ...(headers || {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Media stream HTTP ${res.status}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeReadable = Readable.fromWeb(res.body as any);
  await streamReadableToFile(nodeReadable, destPath, onProgress, progressRange);
}

async function downloadYoutubeRaw(
  url: string,
  filePrefix: string,
  resolution: string,
  format: string,
  onProgress?: (p: ProgressCallbackPayload) => void
): Promise<{ videoPath?: string; audioPath?: string }> {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) throw new Error("Invalid YouTube video ID");

  const wantAudioOnly = resolution === "audio" || format === "mp3" || format === "wav";
  const targetHeight = resolution === "best" ? 2160 : parseInt(resolution.replace(/\D/g, ""), 10) || 1080;

  // Attempt 1: @distube/ytdl-core v5 (VisionOS / WebEmbedded / Tv / Mweb / WebMusic + SABR + PO Token)
  try {
    const ytdl = getSharedYtdl();
    const info = await ytdl.getInfo(videoId, { signal: AbortSignal.timeout(14000) });

    if (wantAudioOnly) {
      const audioFmt = chooseFormat(info.formats, {
        quality: Quality.HighestAudio,
        filter: [{ hasAudio: true, hasVideo: false }, { hasAudio: true }],
      });
      const audioDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.${audioFmt.container || "m4a"}`);
      const started = Date.now();
      let lastReport = 0;
      const stream = ytdl.download(info, {
        format: audioFmt,
        signal: AbortSignal.timeout(45000),
        onProgress: (ev) => {
          const now = Date.now();
          if (onProgress && now - lastReport >= 350) {
            lastReport = now;
            const sec = Math.max(0.1, (now - started) / 1000);
            const speed = Number((ev.downloaded / (1024 * 1024) / sec).toFixed(1));
            const ratio = ev.total ? ev.downloaded / ev.total : 0.5;
            onProgress({
              progress: Math.round(25 + ratio * 48),
              speedMbps: speed,
              etaSeconds: ev.total && speed > 0 ? Math.max(1, Math.round((ev.total - ev.downloaded) / (1024 * 1024) / speed)) : 2,
            });
          }
        },
      });
      await pipeline(stream, fs.createWriteStream(audioDest));
      if (fs.existsSync(audioDest) && fs.statSync(audioDest).size > 512) {
        return { audioPath: audioDest };
      }
    } else {
      // Check if a muxed format satisfies requested height (e.g. 360p/720p), else download adaptive video + audio
      const muxedCandidates = info.formats
        .filter((f) => f.hasVideo && f.hasAudio && !f.isHLS && (f.height || 360) <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const adaptiveVideoCandidates = info.formats
        .filter((f) => f.hasVideo && !f.isHLS && (f.height || 360) <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      const bestMuxed = muxedCandidates[0];
      const bestAdaptive = adaptiveVideoCandidates[0];

      if (bestMuxed && (!bestAdaptive || (bestMuxed.height || 0) >= Math.min(targetHeight, bestAdaptive.height || 0))) {
        const vidDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_mux.${bestMuxed.container || "mp4"}`);
        const stream = ytdl.download(info, {
          format: bestMuxed,
          signal: AbortSignal.timeout(45000),
        });
        await streamReadableToFile(stream, vidDest, onProgress, [25, 72]);
        return { videoPath: vidDest };
      }

      if (bestAdaptive) {
        const vidDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_vid.${bestAdaptive.container || "mp4"}`);
        const audioFmt = chooseFormat(info.formats, {
          quality: Quality.HighestAudio,
          filter: [{ hasAudio: true, hasVideo: false }, { hasAudio: true }],
        });
        const audDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.${audioFmt.container || "m4a"}`);

        await Promise.all([
          streamReadableToFile(
            ytdl.download(info, { format: bestAdaptive, signal: AbortSignal.timeout(45000) }),
            vidDest,
            onProgress,
            [25, 65]
          ),
          pipeline(
            ytdl.download(info, { format: audioFmt, signal: AbortSignal.timeout(45000) }),
            fs.createWriteStream(audDest)
          ),
        ]);
        return { videoPath: vidDest, audioPath: audDest };
      }
    }
  } catch {
    /* Fall through to Piped / Invidious stream proxy */
  }

  // Attempt 2: Piped / Invidious stream URLs
  const direct = await resolveDirectStreamUrls(url, "youtube", resolution, format);
  if (wantAudioOnly && (direct.audioUrl || direct.videoUrl)) {
    const audDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.m4a`);
    await downloadHttpUrlToFile((direct.audioUrl || direct.videoUrl)!, audDest, direct.headers, onProgress);
    return { audioPath: audDest };
  }
  if (direct.videoUrl) {
    const vidDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_vid.mp4`);
    await downloadHttpUrlToFile(direct.videoUrl, vidDest, direct.headers, onProgress, [25, 65]);
    let audDest: string | undefined;
    if (direct.audioUrl) {
      audDest = path.join(MEDIA_TMP_DIR, `${filePrefix}_aud.m4a`);
      try {
        await downloadHttpUrlToFile(direct.audioUrl, audDest, direct.headers);
      } catch {
        audDest = undefined;
      }
    }
    return { videoPath: vidDest, audioPath: audDest };
  }

  throw new Error("All YouTube stream resolvers failed or stream is geo/DRM restricted");
}

async function runFfmpegProcess(params: {
  videoPath?: string;
  audioPath?: string;
  outputPath: string;
  format: string;
  trimStart: string | null;
  trimEnd: string | null;
}): Promise<void> {
  const ffmpeg = resolveFfmpegBin();
  const args: string[] = ["-y"];

  if (params.trimStart) {
    args.push("-ss", params.trimStart);
  }
  if (params.trimEnd) {
    args.push("-to", params.trimEnd);
  }

  if (params.videoPath) {
    args.push("-i", params.videoPath);
  }
  if (params.audioPath) {
    if (params.trimStart && params.videoPath) {
      args.push("-ss", params.trimStart);
    }
    if (params.trimEnd && params.videoPath) {
      args.push("-to", params.trimEnd);
    }
    args.push("-i", params.audioPath);
  }

  if (params.format === "mp3") {
    args.push("-vn", "-acodec", "libmp3lame", "-q:a", "2");
  } else if (params.format === "wav") {
    args.push("-vn", "-acodec", "pcm_s16le", "-ar", "44100");
  } else if (params.format === "webm") {
    if (params.videoPath && params.audioPath) {
      args.push("-map", "0:v:0", "-map", "1:a:0?");
    }
    args.push("-c:v", "libvpx", "-b:v", "1M", "-c:a", "libvorbis", "-shortest");
  } else {
    // mp4: fast stream-copy when possible, fallback to ultrafast H.264 + AAC
    if (params.videoPath && params.audioPath) {
      args.push("-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart");
    } else if (!params.trimStart && !params.trimEnd && params.videoPath?.endsWith(".mp4")) {
      args.push("-c", "copy", "-movflags", "+faststart");
    } else {
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart");
    }
  }

  args.push(params.outputPath);

  try {
    await execFileAsync(ffmpeg, args, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // Fallback transcode if stream-copy failed on container/codec mismatch
    const fallbackArgs: string[] = ["-y"];
    if (params.trimStart) fallbackArgs.push("-ss", params.trimStart);
    if (params.trimEnd) fallbackArgs.push("-to", params.trimEnd);
    if (params.videoPath) fallbackArgs.push("-i", params.videoPath);
    if (params.audioPath) fallbackArgs.push("-i", params.audioPath);
    if (params.format === "mp3") {
      fallbackArgs.push("-vn", "-acodec", "libmp3lame", "-q:a", "2");
    } else if (params.format === "wav") {
      fallbackArgs.push("-vn", "-acodec", "pcm_s16le");
    } else {
      fallbackArgs.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-movflags", "+faststart");
    }
    fallbackArgs.push(params.outputPath);
    await execFileAsync(ffmpeg, fallbackArgs, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 });
  }
}

function safeUnlink(p: string | undefined) {
  if (!p) return;
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

  let videoPath: string | undefined;
  let audioPath: string | undefined;

  try {
    if (params.platform === "youtube") {
      const dl = await downloadYoutubeRaw(
        params.url,
        params.fileKey,
        params.resolution,
        ext,
        params.onProgress
      );
      videoPath = dl.videoPath;
      audioPath = dl.audioPath;
    } else {
      const direct = await resolveDirectStreamUrls(
        params.url,
        params.platform,
        params.resolution,
        ext
      );
      const wantAudioOnly = params.resolution === "audio" || ext === "mp3" || ext === "wav";
      if (wantAudioOnly && (direct.audioUrl || direct.videoUrl)) {
        audioPath = path.join(MEDIA_TMP_DIR, `${params.fileKey}_aud.mp4`);
        await downloadHttpUrlToFile(
          (direct.audioUrl || direct.videoUrl)!,
          audioPath,
          direct.headers,
          params.onProgress
        );
      } else if (direct.videoUrl) {
        videoPath = path.join(MEDIA_TMP_DIR, `${params.fileKey}_vid.mp4`);
        await downloadHttpUrlToFile(direct.videoUrl, videoPath, direct.headers, params.onProgress, [25, 65]);
        if (direct.audioUrl) {
          audioPath = path.join(MEDIA_TMP_DIR, `${params.fileKey}_aud.mp4`);
          try {
            await downloadHttpUrlToFile(direct.audioUrl, audioPath, direct.headers);
          } catch {
            audioPath = undefined;
          }
        }
      } else {
        throw new Error("Could not resolve downloadable media stream URL");
      }
    }

    params.onProgress?.({ progress: 76, speedMbps: 0, etaSeconds: 2 });

    await runFfmpegProcess({
      videoPath,
      audioPath,
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
    safeUnlink(videoPath);
    safeUnlink(audioPath);
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
