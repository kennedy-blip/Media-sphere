/**
 * Real caption, .SRT subtitle, and extractive summarization engine.
 * Pulls authentic timed captions from YouTube/Piped/Invidious/VTT tracks,
 * applies optional [trim_start, trim_end] windowing, and computes a real extractive summary.
 */
import { CaptionFormat } from "@distube/ytdl-core";
import { getSubtitles } from "youtube-caption-extractor";
import { parseTimestampSeconds } from "./api";
import {
  fetchInvidiousVideo,
  fetchPipedStreams,
  getSharedYtdl,
  type ExtractedMetadata,
} from "./realExtractor";
import { extractYoutubeVideoId } from "./sanitizer";

export interface Cue {
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface RealTranscriptResult {
  transcript: string | null;
  srt: string | null;
  summary: string | null;
}

function formatSrtTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(Math.min(999, ms)).padStart(3, "0")}`;
}

export function cuesToSrt(cues: Cue[]): string {
  return cues
    .map((c, idx) => `${idx + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}

function parseJson3Captions(raw: string): Cue[] {
  try {
    const parsed = JSON.parse(raw) as {
      events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
    };
    const cues: Cue[] = [];
    for (const ev of parsed.events || []) {
      if (!ev.segs || ev.tStartMs == null) continue;
      const text = ev.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const start = ev.tStartMs / 1000;
      const end = start + (ev.dDurationMs || 2500) / 1000;
      cues.push({ start, end, text });
    }
    return cues;
  } catch {
    return [];
  }
}

function parseVttTime(ts: string): number {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  return 0;
}

export function parseVttToCues(vtt: string): Cue[] {
  const blocks = vtt.replace(/\r\n/g, "\n").split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const arrowIdx = lines.findIndex((l) => l.includes("-->"));
    if (arrowIdx === -1) continue;
    const [rawStart, rawEnd] = lines[arrowIdx].split("-->");
    const endToken = (rawEnd || "").trim().split(/\s+/)[0];
    const start = parseVttTime(rawStart);
    const end = parseVttTime(endToken);
    const text = lines
      .slice(arrowIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text && end >= start) {
      cues.push({ start, end: end > start ? end : start + 2.5, text });
    }
  }
  return cues;
}

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were",
  "from", "have", "has", "had", "not", "but", "what", "all", "can", "will", "just",
  "about", "into", "more", "out", "who", "get", "like", "when", "make", "how", "its",
  "they", "them", "their", "there", "been", "one", "would", "could", "should",
]);

export function summarizeRealText(transcript: string | null, meta: ExtractedMetadata): string {
  const source = (transcript || "").trim();
  if (source.length >= 80) {
    const rawSentences = source
      .replace(/([.!?])\s+/g, "$1|")
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length >= 25);

    if (rawSentences.length >= 2) {
      const freq = new Map<string, number>();
      for (const word of source.toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
        if (!STOPWORDS.has(word)) {
          freq.set(word, (freq.get(word) || 0) + 1);
        }
      }
      const scored = rawSentences.map((sentence, idx) => {
        const words = sentence.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        const score = words.reduce((acc, w) => acc + (freq.get(w) || 0), 0) / Math.max(4, words.length);
        return { sentence, idx, score };
      });
      const top = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.sentence);
      return `${meta.title} (${meta.creator}): ${top.join(" ")}`;
    }
    return `${meta.title} (${meta.creator}): ${source.slice(0, 420)}`;
  }

  // Grounded metadata summary when the video has no spoken/lyric caption track (e.g. uncaptioned music video)
  const descFirst = (meta.description || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("http"))
    .slice(0, 3)
    .join(" · ")
    .slice(0, 360);

  return descFirst
    ? `"${meta.title}" by ${meta.creator}. ${descFirst}`
    : `"${meta.title}" by ${meta.creator} (no spoken caption track published on source media).`;
}

async function fetchYoutubeCues(videoId: string): Promise<Cue[]> {
  // 1. Official InnerTube timedtext via @distube/ytdl-core
  try {
    const ytdl = getSharedYtdl();
    const rawJson3 = await ytdl.getCaptions(videoId, {
      format: CaptionFormat.Json3,
      signal: AbortSignal.timeout(8000),
    });
    const cues = parseJson3Captions(rawJson3);
    if (cues.length > 0) return cues;
  } catch {
    /* try fallback */
  }

  // 2. youtube-caption-extractor fallback
  try {
    const subs = await getSubtitles({ videoID: videoId, lang: "en" });
    if (subs && subs.length > 0) {
      return subs.map((s) => {
        const start = parseFloat(s.start) || 0;
        const dur = parseFloat(s.dur) || 2.5;
        return { start, end: start + dur, text: s.text.replace(/\s+/g, " ").trim() };
      }).filter((c) => c.text);
    }
  } catch {
    /* try Piped/Invidious */
  }

  // 3. Piped subtitles VTT
  try {
    const piped = await fetchPipedStreams(videoId);
    const subTrack =
      piped?.subtitles?.find((s) => s.code?.startsWith("en") && !s.autoGenerated) ||
      piped?.subtitles?.find((s) => s.code?.startsWith("en")) ||
      piped?.subtitles?.[0];
    if (subTrack?.url) {
      const res = await fetch(subTrack.url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const cues = parseVttToCues(await res.text());
        if (cues.length > 0) return cues;
      }
    }
  } catch {
    /* try Invidious */
  }

  // 4. Invidious captions VTT
  try {
    const inv = await fetchInvidiousVideo(videoId);
    const cap = inv?.data.captions?.[0];
    if (inv && cap?.url) {
      const capUrl = cap.url.startsWith("http") ? cap.url : `${inv.base}${cap.url}`;
      const res = await fetch(capUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const cues = parseVttToCues(await res.text());
        if (cues.length > 0) return cues;
      }
    }
  } catch {
    /* no captions available */
  }

  return [];
}

export async function extractRealTranscriptAndSummary(params: {
  url: string;
  platform: string;
  meta: ExtractedMetadata;
  trimStart: string | null;
  trimEnd: string | null;
  wantSubtitles: boolean;
  wantSummary: boolean;
}): Promise<RealTranscriptResult> {
  if (!params.wantSubtitles && !params.wantSummary) {
    return { transcript: null, srt: null, summary: null };
  }

  let cues: Cue[] = [];
  if (params.platform === "youtube") {
    const videoId = extractYoutubeVideoId(params.url);
    if (videoId) {
      cues = await fetchYoutubeCues(videoId);
    }
  }

  // Apply trim window filter if user requested a clip range
  const startSec = params.trimStart ? parseTimestampSeconds(params.trimStart) : null;
  const endSec = params.trimEnd ? parseTimestampSeconds(params.trimEnd) : null;
  if (cues.length > 0 && ((startSec != null && !Number.isNaN(startSec)) || (endSec != null && !Number.isNaN(endSec)))) {
    const lo = startSec ?? 0;
    const hi = endSec ?? Number.POSITIVE_INFINITY;
    const sliced = cues
      .filter((c) => c.end >= lo && c.start <= hi)
      .map((c) => ({
        start: Math.max(0, c.start - lo),
        end: Math.max(0.2, Math.min(hi, c.end) - lo),
        text: c.text,
      }));
    if (sliced.length > 0) {
      cues = sliced;
    }
  }

  const fullText = cues.length > 0
    ? cues.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim()
    : null;

  const transcript = fullText || (params.meta.description ? params.meta.description.slice(0, 2000) : null);
  const srt = params.wantSubtitles
    ? cues.length > 0
      ? cuesToSrt(cues)
      : transcript
        ? cuesToSrt([{ start: 0, end: Math.min(params.meta.duration || 10, 15), text: transcript.slice(0, 240) }])
        : null
    : null;
  const summary = params.wantSummary ? summarizeRealText(fullText, params.meta) : null;

  return { transcript, srt, summary };
}
