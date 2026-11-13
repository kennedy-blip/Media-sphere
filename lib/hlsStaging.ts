/**
 * Stage a conservative subset of HLS without giving FFmpeg network access.
 * Unsupported playlists fail closed rather than being passed to FFmpeg.
 */
import fs from "node:fs/promises";
import { safeFetch } from "./outboundSecurity";

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_SEGMENTS = 500;

async function readPlaylist(url: string, headers?: Record<string, string>) {
  const response = await safeFetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error(`HLS playlist HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PLAYLIST_BYTES) throw new Error("HLS playlist too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), base: response.url || url };
}

/** Stage unencrypted, non-live MPEG-TS segment playlists; reject other variants. */
export async function stageHlsMedia(url: string, dest: string, headers?: Record<string, string>): Promise<void> {
  let playlistUrl = url;
  let segments: string[] | undefined;
  for (let depth = 0; depth < 4; depth++) {
    const { text, base } = await readPlaylist(playlistUrl, headers);
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("Invalid HLS playlist");
    // These require decryption, fMP4 initialization, byte ranges, or other
    // timeline/rendition semantics that concatenating segments cannot preserve.
    if (lines.some((line) => /^#EXT-X-(?:KEY|SESSION-KEY|MAP|BYTERANGE|DEFINE|DISCONTINUITY|GAP|PART|MEDIA|I-FRAME-STREAM-INF)(?::|$)/i.test(line))) {
      throw new Error("Unsupported HLS playlist features");
    }
    const variants = lines.filter((line) => !line.startsWith("#"));
    if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) {
      if (!variants.length) throw new Error("Empty HLS master playlist");
      playlistUrl = new URL(variants[0], base).toString();
      continue;
    }
    if (!lines.includes("#EXT-X-ENDLIST") || !variants.length || variants.length > MAX_SEGMENTS) {
      throw new Error("Unsupported live, empty or oversized HLS playlist");
    }
    segments = variants.map((line) => new URL(line, base).toString());
    break;
  }
  if (!segments) throw new Error("HLS playlist nesting limit exceeded");

  const file = await fs.open(dest, "w");
  let size = 0;
  let success = false;
  try {
    for (const segment of segments) {
      const response = await safeFetch(segment, { headers, signal: AbortSignal.timeout(90000) });
      if (!response.ok || !response.body) throw new Error(`HLS segment HTTP ${response.status}`);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_MEDIA_BYTES) throw new Error("HLS media too large");
          await file.writeFile(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    if (size < 256) throw new Error("HLS media was empty");
    success = true;
  } finally {
    await file.close();
    if (!success) await fs.unlink(dest).catch(() => undefined);
  }
}
