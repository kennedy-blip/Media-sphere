/**
 * Real-world multi-platform metadata & stream resolver.
 * Supports YouTube, TikTok, Instagram, X/Twitter, Reddit, Pinterest, Vimeo, Twitch, Facebook, LinkedIn.
 */
import { Client, Ytdl, type VideoInfo } from "@distube/ytdl-core";
import { extractYoutubeVideoId } from "./sanitizer";

export interface FormatItem {
  format_id: string;
  label: string;
  ext: string;
  resolution: string;
  filesize: number | null;
  fps?: number;
  abr?: number;
}

export interface ExtractedMetadata {
  title: string;
  description: string;
  creator: string;
  avatar: string | null;
  thumbnail: string | null;
  views: number | null;
  likes: number | null;
  upload_date: string | null;
  tags: string[];
  duration: number | null;
  formats: FormatItem[];
}

export interface DirectStreamBundle {
  videoUrl?: string;
  audioUrl?: string;
  headers?: Record<string, string>;
  captionUrl?: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.drgns.space",
];

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.jing.rocks",
  "https://yewtu.be",
];

let sharedYtdl: Ytdl | null = null;

export function getSharedYtdl(): Ytdl {
  if (!sharedYtdl) {
    sharedYtdl = new Ytdl({
      clients: [
        Client.VisionOS,
        Client.WebEmbedded,
        Client.Tv,
        Client.Mweb,
        Client.WebMusic,
      ],
      timeoutMs: 14000,
    });
  }
  return sharedYtdl;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseIso8601Duration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = Math.round(parseFloat(m[3] || "0"));
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

function defaultFormats(duration: number | null): FormatItem[] {
  const dur = duration && duration > 0 ? duration : 210;
  return [
    { format_id: "2160p", label: "4K (2160p)", ext: "mp4", resolution: "2160p", filesize: Math.round(dur * 2_200_000), fps: 60 },
    { format_id: "1080p", label: "Full HD (1080p)", ext: "mp4", resolution: "1080p", filesize: Math.round(dur * 750_000), fps: 30 },
    { format_id: "720p", label: "HD (720p)", ext: "mp4", resolution: "720p", filesize: Math.round(dur * 380_000), fps: 30 },
    { format_id: "480p", label: "SD (480p)", ext: "mp4", resolution: "480p", filesize: Math.round(dur * 190_000), fps: 30 },
    { format_id: "360p", label: "360p", ext: "mp4", resolution: "360p", filesize: Math.round(dur * 95_000), fps: 30 },
    { format_id: "audio", label: "Audio Best (MP3/WAV)", ext: "mp3", resolution: "audio", filesize: Math.round(dur * 40_000), abr: 192 },
  ];
}

async function fetchJson<T>(url: string, timeoutMs = 6500, headers?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json, text/plain, */*",
        ...(headers || {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchHtml(url: string, timeoutMs = 7000, ua = BROWSER_UA): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractMetaTag(html: string, attrValue: string): string | null {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1].trim());
  }
  return null;
}

// ============================================================================
// YOUTUBE REAL EXTRACTOR (ytdl-core v5 + Piped/Invidious + oEmbed + RYD + HTML)
// ============================================================================

export async function fetchYoutubeYtdlInfo(videoId: string, timeoutMs = 12000): Promise<VideoInfo | null> {
  try {
    const ytdl = getSharedYtdl();
    return await ytdl.getInfo(videoId, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

interface PipedResponse {
  title?: string;
  description?: string;
  uploader?: string;
  uploaderAvatar?: string;
  thumbnailUrl?: string;
  views?: number;
  likes?: number;
  uploadDate?: string;
  duration?: number;
  videoStreams?: Array<{ url?: string; quality?: string; format?: string; height?: number; fps?: number; videoOnly?: boolean; contentLength?: number }>;
  audioStreams?: Array<{ url?: string; mimeType?: string; bitrate?: number; contentLength?: number }>;
  subtitles?: Array<{ url?: string; code?: string; autoGenerated?: boolean }>;
}

export async function fetchPipedStreams(videoId: string): Promise<PipedResponse | null> {
  for (const base of PIPED_INSTANCES) {
    const data = await fetchJson<PipedResponse>(`${base}/streams/${videoId}`, 4500);
    if (data && data.title && (data.videoStreams?.length || data.audioStreams?.length)) {
      return data;
    }
  }
  return null;
}

interface InvidiousResponse {
  title?: string;
  description?: string;
  author?: string;
  authorThumbnails?: Array<{ url?: string }>;
  videoThumbnails?: Array<{ url?: string; quality?: string }>;
  viewCount?: number;
  likeCount?: number;
  publishedText?: string;
  lengthSeconds?: number;
  keywords?: string[];
  formatStreams?: Array<{ url?: string; itag?: string; resolution?: string; container?: string }>;
  adaptiveFormats?: Array<{ url?: string; itag?: string; type?: string; resolution?: string; clen?: string; bitrate?: string }>;
  captions?: Array<{ label?: string; language_code?: string; url?: string }>;
}

export async function fetchInvidiousVideo(videoId: string): Promise<{ base: string; data: InvidiousResponse } | null> {
  for (const base of INVIDIOUS_INSTANCES) {
    const data = await fetchJson<InvidiousResponse>(`${base}/api/v1/videos/${videoId}`, 4500);
    if (data && data.title) {
      return { base, data };
    }
  }
  return null;
}

async function extractYoutubeMetadata(url: string): Promise<ExtractedMetadata> {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) {
    throw new Error("Could not parse a valid 11-character YouTube video ID from URL");
  }
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Fire guaranteed fast endpoints (oEmbed + ReturnYouTubeDislike + Watch HTML) in parallel with Ytdl player info
  const [oembed, ryd, ytdlInfo, watchHtml] = await Promise.all([
    fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      5000
    ),
    fetchJson<{ viewCount?: number; likes?: number }>(
      `https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`,
      4500
    ),
    fetchYoutubeYtdlInfo(videoId, 10000),
    fetchHtml(`${watchUrl}&hl=en`, 5500),
  ]);

  if (ytdlInfo?.videoDetails?.title) {
    const vd = ytdlInfo.videoDetails;
    const formats: FormatItem[] = [];
    const seenRes = new Set<string>();
    const sorted = [...ytdlInfo.formats].sort((a, b) => (b.height || 0) - (a.height || 0));
    for (const f of sorted) {
      if (f.hasVideo && f.height) {
        const resKey = `${f.height}p`;
        if (!seenRes.has(resKey)) {
          seenRes.add(resKey);
          formats.push({
            format_id: String(f.itag),
            label: f.qualityLabel || resKey,
            ext: f.container || "mp4",
            resolution: resKey,
            filesize: f.contentLength ?? null,
            fps: f.fps,
          });
        }
      }
    }
    const bestAudio = sorted.find((f) => f.hasAudio && !f.hasVideo);
    if (bestAudio) {
      formats.push({
        format_id: String(bestAudio.itag),
        label: `Audio ${bestAudio.audioBitrate || 128}kbps`,
        ext: bestAudio.container || "m4a",
        resolution: "audio",
        filesize: bestAudio.contentLength ?? null,
        abr: bestAudio.audioBitrate,
      });
    }

    const bestThumb =
      vd.thumbnails[vd.thumbnails.length - 1]?.url ||
      oembed?.thumbnail_url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const avatar = vd.author?.thumbnails?.[vd.author.thumbnails.length - 1]?.url ?? null;

    return {
      title: vd.title,
      description: vd.description || "",
      creator: vd.author?.name || oembed?.author_name || "YouTube Creator",
      avatar,
      thumbnail: bestThumb,
      views: vd.viewCount ?? ryd?.viewCount ?? null,
      likes: vd.likes ?? ryd?.likes ?? null,
      upload_date: vd.publishDate || vd.uploadDate || null,
      tags: vd.keywords ? [...vd.keywords].slice(0, 20) : [],
      duration: vd.lengthSeconds || null,
      formats: formats.length ? formats : defaultFormats(vd.lengthSeconds || null),
    };
  }

  // Fallback Tier 2: Piped or Invidious API
  const piped = await fetchPipedStreams(videoId);
  if (piped?.title) {
    return {
      title: piped.title,
      description: (piped.description || "").slice(0, 2000),
      creator: piped.uploader || oembed?.author_name || "YouTube Creator",
      avatar: piped.uploaderAvatar || null,
      thumbnail: piped.thumbnailUrl || oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: piped.views ?? ryd?.viewCount ?? null,
      likes: piped.likes ?? ryd?.likes ?? null,
      upload_date: piped.uploadDate || null,
      tags: [],
      duration: piped.duration ?? null,
      formats: defaultFormats(piped.duration ?? null),
    };
  }

  const inv = await fetchInvidiousVideo(videoId);
  if (inv?.data?.title) {
    const d = inv.data;
    return {
      title: d.title!,
      description: (d.description || "").slice(0, 2000),
      creator: d.author || oembed?.author_name || "YouTube Creator",
      avatar: d.authorThumbnails?.[0]?.url || null,
      thumbnail: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views: d.viewCount ?? ryd?.viewCount ?? null,
      likes: d.likeCount ?? ryd?.likes ?? null,
      upload_date: d.publishedText || null,
      tags: (d.keywords || []).slice(0, 20),
      duration: d.lengthSeconds ?? null,
      formats: defaultFormats(d.lengthSeconds ?? null),
    };
  }

  // Fallback Tier 3: Official YouTube oEmbed + Watch HTML microdata + ReturnYouTubeDislike
  const htmlTitle = watchHtml ? extractMetaTag(watchHtml, "og:title") || extractMetaTag(watchHtml, "title") : null;
  const title = oembed?.title || htmlTitle;
  if (!title || title === "YouTube") {
    throw new Error("YouTube video is unavailable, private, or does not exist");
  }

  const htmlDesc = watchHtml
    ? extractMetaTag(watchHtml, "og:description") || extractMetaTag(watchHtml, "description") || ""
    : "";
  const isoDur = watchHtml ? extractMetaTag(watchHtml, "duration") : null;
  let duration = parseIso8601Duration(isoDur);
  if (!duration && watchHtml) {
    const lenMatch = watchHtml.match(/"lengthSeconds":"(\d+)"/);
    if (lenMatch) duration = parseInt(lenMatch[1], 10);
  }
  const uploadDate = watchHtml ? extractMetaTag(watchHtml, "datePublished") || extractMetaTag(watchHtml, "uploadDate") : null;
  let views = ryd?.viewCount ?? null;
  if (views == null && watchHtml) {
    const vm = watchHtml.match(/"viewCount":"(\d+)"/);
    if (vm) views = parseInt(vm[1], 10);
  }
  const kwRaw = watchHtml ? extractMetaTag(watchHtml, "keywords") : null;
  const tags = kwRaw ? kwRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 15) : [];

  return {
    title,
    description: htmlDesc,
    creator: oembed?.author_name || (watchHtml ? extractMetaTag(watchHtml, "author") : null) || "YouTube Creator",
    avatar: null,
    thumbnail: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    views,
    likes: ryd?.likes ?? null,
    upload_date: uploadDate,
    tags,
    duration,
    formats: defaultFormats(duration),
  };
}

// ============================================================================
// TIKTOK REAL EXTRACTOR (TikWM HD API + Official oEmbed)
// ============================================================================

interface TikwmResponse {
  code?: number;
  data?: {
    id?: string;
    title?: string;
    cover?: string;
    origin_cover?: string;
    duration?: number;
    play?: string;
    hdplay?: string;
    music?: string;
    play_count?: number;
    digg_count?: number;
    create_time?: number;
    author?: { unique_id?: string; nickname?: string; avatar?: string };
  };
}

async function fetchTikwm(url: string): Promise<TikwmResponse["data"] | null> {
  const res = await fetchJson<TikwmResponse>(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
    8000
  );
  if (res && res.code === 0 && res.data) return res.data;
  return null;
}

async function extractTiktokMetadata(url: string): Promise<ExtractedMetadata> {
  const [tikwm, oembed] = await Promise.all([
    fetchTikwm(url),
    fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      6000
    ),
  ]);

  if (tikwm) {
    const handle = tikwm.author?.unique_id ? `@${tikwm.author.unique_id}` : tikwm.author?.nickname || oembed?.author_name || "TikTok Creator";
    const uploadDate = tikwm.create_time ? new Date(tikwm.create_time * 1000).toISOString().slice(0, 10) : null;
    const title = tikwm.title?.trim() || oembed?.title?.trim() || `TikTok by ${handle}`;
    return {
      title: title.slice(0, 180),
      description: tikwm.title || oembed?.title || "",
      creator: handle,
      avatar: tikwm.author?.avatar || null,
      thumbnail: tikwm.origin_cover || tikwm.cover || oembed?.thumbnail_url || null,
      views: tikwm.play_count ?? null,
      likes: tikwm.digg_count ?? null,
      upload_date: uploadDate,
      tags: (title.match(/#[\w]+/g) || []).map((t) => t.slice(1)).slice(0, 15),
      duration: tikwm.duration ?? null,
      formats: defaultFormats(tikwm.duration ?? 30),
    };
  }

  if (oembed?.title || oembed?.author_name) {
    return {
      title: (oembed.title || `TikTok Video by ${oembed.author_name}`).slice(0, 180),
      description: oembed.title || "",
      creator: oembed.author_name ? `@${oembed.author_name}` : "TikTok Creator",
      avatar: null,
      thumbnail: oembed.thumbnail_url || null,
      views: null,
      likes: null,
      upload_date: null,
      tags: [],
      duration: null,
      formats: defaultFormats(30),
    };
  }

  throw new Error("Could not extract TikTok metadata — check that the video is public");
}

// ============================================================================
// X / TWITTER REAL EXTRACTOR (FxTwitter + VxTwitter API)
// ============================================================================

interface FxTweetResponse {
  tweet?: {
    text?: string;
    created_at?: string;
    views?: number;
    likes?: number;
    author?: { name?: string; screen_name?: string; avatar_url?: string };
    media?: {
      videos?: Array<{
        url?: string;
        thumbnail_url?: string;
        duration?: number;
        variants?: Array<{ content_type?: string; url?: string; bitrate?: number }>;
      }>;
      photos?: Array<{ url?: string }>;
    };
  };
}

function parseTweetId(url: string): string | null {
  const m = url.match(/\/status\/(\d+)/i);
  return m ? m[1] : null;
}

async function extractXMetadata(url: string): Promise<ExtractedMetadata> {
  const tweetId = parseTweetId(url);
  if (!tweetId) throw new Error("X/Twitter URL must contain /status/<tweet_id>");

  const fx = await fetchJson<FxTweetResponse>(`https://api.fxtwitter.com/status/${tweetId}`, 7000);
  if (fx?.tweet) {
    const tw = fx.tweet;
    const vid = tw.media?.videos?.[0];
    const thumb = vid?.thumbnail_url || tw.media?.photos?.[0]?.url || null;
    const dur = vid?.duration ? Math.round(vid.duration) : null;
    const creator = tw.author?.screen_name ? `@${tw.author.screen_name}` : tw.author?.name || "X User";
    const text = (tw.text || "").trim();
    return {
      title: (text.split("\n")[0] || `Post by ${creator}`).slice(0, 140),
      description: text,
      creator,
      avatar: tw.author?.avatar_url || null,
      thumbnail: thumb,
      views: tw.views ?? null,
      likes: tw.likes ?? null,
      upload_date: tw.created_at ? new Date(tw.created_at).toISOString().slice(0, 10) : null,
      tags: (text.match(/#[\w]+/g) || []).map((t) => t.slice(1)),
      duration: dur,
      formats: defaultFormats(dur),
    };
  }

  const vx = await fetchJson<{
    text?: string;
    user_screen_name?: string;
    user_profile_image_url?: string;
    likes?: number;
    media_extended?: Array<{ url?: string; thumbnail_url?: string; duration_millis?: number }>;
  }>(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, 7000);
  if (vx && (vx.text || vx.user_screen_name)) {
    const m = vx.media_extended?.[0];
    const dur = m?.duration_millis ? Math.round(m.duration_millis / 1000) : null;
    return {
      title: ((vx.text || "").split("\n")[0] || `Post by @${vx.user_screen_name}`).slice(0, 140),
      description: vx.text || "",
      creator: vx.user_screen_name ? `@${vx.user_screen_name}` : "X User",
      avatar: vx.user_profile_image_url || null,
      thumbnail: m?.thumbnail_url || null,
      views: null,
      likes: vx.likes ?? null,
      upload_date: null,
      tags: [],
      duration: dur,
      formats: defaultFormats(dur),
    };
  }

  throw new Error("Could not extract X/Twitter post — ensure the post is public");
}

// ============================================================================
// VIMEO REAL EXTRACTOR
// ============================================================================

async function extractVimeoMetadata(url: string): Promise<ExtractedMetadata> {
  const oembed = await fetchJson<{
    title?: string;
    description?: string;
    author_name?: string;
    thumbnail_url?: string;
    duration?: number;
    upload_date?: string;
    video_id?: number;
  }>(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`, 7000);

  if (!oembed?.title) {
    throw new Error("Could not extract Vimeo video — ensure the video is public");
  }
  return {
    title: oembed.title,
    description: oembed.description || "",
    creator: oembed.author_name || "Vimeo Creator",
    avatar: null,
    thumbnail: oembed.thumbnail_url || null,
    views: null,
    likes: null,
    upload_date: oembed.upload_date ? oembed.upload_date.slice(0, 10) : null,
    tags: [],
    duration: oembed.duration ?? null,
    formats: defaultFormats(oembed.duration ?? null),
  };
}

// ============================================================================
// REDDIT REAL EXTRACTOR
// ============================================================================

async function resolveRedirect(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(5000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

async function extractRedditMetadata(url: string): Promise<ExtractedMetadata> {
  const fullUrl = url.includes("redd.it") ? await resolveRedirect(url) : url;
  const cleanPath = fullUrl.split("?")[0].replace(/\/+$/, "");
  const jsonUrl = `${cleanPath}.json?raw_json=1`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await fetchJson<any[]>(jsonUrl, 7000, {
    "User-Agent": "MediaSphere/1.0 (RealMediaExtractor)",
  });
  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post?.title) {
    throw new Error("Could not extract Reddit post metadata");
  }
  const rv = post.secure_media?.reddit_video || post.media?.reddit_video;
  const previewImg = post.preview?.images?.[0]?.source?.url || (post.thumbnail?.startsWith("http") ? post.thumbnail : null);
  return {
    title: post.title,
    description: post.selftext || `Posted in r/${post.subreddit}`,
    creator: post.author ? `u/${post.author}` : "Reddit User",
    avatar: null,
    thumbnail: previewImg,
    views: post.view_count ?? null,
    likes: post.ups ?? null,
    upload_date: post.created_utc ? new Date(post.created_utc * 1000).toISOString().slice(0, 10) : null,
    tags: post.subreddit ? [post.subreddit] : [],
    duration: rv?.duration ?? null,
    formats: defaultFormats(rv?.duration ?? null),
  };
}

// ============================================================================
// GENERIC OPENGRAPH / JSON-LD REAL EXTRACTOR (Instagram, Facebook, Twitch, Pinterest, LinkedIn)
// ============================================================================

async function extractOpenGraphMetadata(url: string, platform: string): Promise<ExtractedMetadata> {
  // Twitch Clips GraphQL fast path
  if (platform === "twitch") {
    const clipSlug =
      url.match(/clips\.twitch\.tv\/([\w-]+)/i)?.[1] ||
      url.match(/\/clip\/([\w-]+)/i)?.[1];
    if (clipSlug) {
      try {
        const res = await fetch("https://gql.twitch.tv/gql", {
          method: "POST",
          headers: {
            "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `query { clip(slug: "${clipSlug}") { title viewCount durationSeconds createdAt thumbnailURL broadcaster { displayName profileImageURL(width: 70) } } }`,
          }),
          signal: AbortSignal.timeout(6000),
        });
        const gql = await res.json();
        const clip = gql?.data?.clip;
        if (clip?.title) {
          return {
            title: clip.title,
            description: `Twitch clip from ${clip.broadcaster?.displayName || "Twitch"}`,
            creator: clip.broadcaster?.displayName || "Twitch Streamer",
            avatar: clip.broadcaster?.profileImageURL || null,
            thumbnail: clip.thumbnailURL || null,
            views: clip.viewCount ?? null,
            likes: null,
            upload_date: clip.createdAt ? clip.createdAt.slice(0, 10) : null,
            tags: ["twitch", "clip"],
            duration: clip.durationSeconds ?? null,
            formats: defaultFormats(clip.durationSeconds ?? 30),
          };
        }
      } catch {
        /* fall through to OpenGraph */
      }
    }
  }

  const html =
    (await fetchHtml(url, 7000, "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")) ||
    (await fetchHtml(url, 7000, BROWSER_UA));

  if (!html) {
    throw new Error(`Unable to reach ${platform} URL — check that the post is public`);
  }

  const title =
    extractMetaTag(html, "og:title") ||
    extractMetaTag(html, "twitter:title") ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

  if (!title) {
    throw new Error(`Could not extract public metadata from ${platform} URL`);
  }

  const description =
    extractMetaTag(html, "og:description") ||
    extractMetaTag(html, "twitter:description") ||
    extractMetaTag(html, "description") ||
    "";
  const thumbnail =
    extractMetaTag(html, "og:image") ||
    extractMetaTag(html, "twitter:image") ||
    null;
  const author =
    extractMetaTag(html, "author") ||
    extractMetaTag(html, "og:site_name") ||
    platform;

  return {
    title: decodeHtmlEntities(title).slice(0, 180),
    description: decodeHtmlEntities(description).slice(0, 1500),
    creator: author,
    avatar: null,
    thumbnail,
    views: null,
    likes: null,
    upload_date: null,
    tags: [platform],
    duration: null,
    formats: defaultFormats(null),
  };
}

// ============================================================================
// UNIFIED METADATA ENTRYPOINT
// ============================================================================

export async function extractRealMetadata(url: string, platform: string): Promise<ExtractedMetadata> {
  switch (platform) {
    case "youtube":
      return extractYoutubeMetadata(url);
    case "tiktok":
      return extractTiktokMetadata(url);
    case "x":
      return extractXMetadata(url);
    case "vimeo":
      return extractVimeoMetadata(url);
    case "reddit":
      return extractRedditMetadata(url);
    default:
      return extractOpenGraphMetadata(url, platform);
  }
}

// ============================================================================
// STREAM URL RESOLVER FOR NON-YTDL & FALLBACK DOWNLOADS
// ============================================================================

export async function resolveDirectStreamUrls(
  url: string,
  platform: string,
  resolution: string,
  format: string
): Promise<DirectStreamBundle> {
  const wantAudioOnly = resolution === "audio" || format === "mp3" || format === "wav";
  const targetHeight = parseInt(resolution.replace(/\D/g, ""), 10) || 1080;

  if (platform === "youtube") {
    const videoId = extractYoutubeVideoId(url);
    if (!videoId) throw new Error("Invalid YouTube video ID");

    // Fallback stream lookup via Piped / Invidious (used when direct ytdl-core encounters datacenter challenge)
    const piped = await fetchPipedStreams(videoId);
    if (piped) {
      const bestAudio = [...(piped.audioStreams || [])]
        .filter((a) => a.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (wantAudioOnly && bestAudio?.url) {
        return { audioUrl: bestAudio.url };
      }
      const muxed = [...(piped.videoStreams || [])]
        .filter((v) => v.url && !v.videoOnly && (v.height || 720) <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (muxed?.url) {
        return { videoUrl: muxed.url };
      }
      const adaptiveVid = [...(piped.videoStreams || [])]
        .filter((v) => v.url && (v.height || 1080) <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (adaptiveVid?.url) {
        return { videoUrl: adaptiveVid.url, audioUrl: bestAudio?.url };
      }
    }

    const inv = await fetchInvidiousVideo(videoId);
    if (inv) {
      const { base, data } = inv;
      if (wantAudioOnly) {
        const audio = (data.adaptiveFormats || []).find((f) => f.type?.startsWith("audio/") && f.itag);
        if (audio?.itag) {
          return { audioUrl: `${base}/latest_version?id=${videoId}&itag=${audio.itag}&local=true` };
        }
      }
      const muxed = (data.formatStreams || [])[0];
      if (muxed?.itag) {
        return { videoUrl: `${base}/latest_version?id=${videoId}&itag=${muxed.itag}&local=true` };
      }
    }
    return {};
  }

  if (platform === "tiktok") {
    const tikwm = await fetchTikwm(url);
    if (tikwm) {
      if (wantAudioOnly && tikwm.music) return { audioUrl: tikwm.music };
      const vUrl = tikwm.hdplay || tikwm.play;
      if (vUrl) return { videoUrl: vUrl };
    }
    throw new Error("Could not resolve direct TikTok media stream");
  }

  if (platform === "x") {
    const tweetId = parseTweetId(url);
    if (tweetId) {
      const fx = await fetchJson<FxTweetResponse>(`https://api.fxtwitter.com/status/${tweetId}`, 7000);
      const vid = fx?.tweet?.media?.videos?.[0];
      if (vid?.url) {
        const mp4Variants = (vid.variants || [])
          .filter((v) => v.content_type === "video/mp4" && v.url)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        return { videoUrl: mp4Variants[0]?.url || vid.url };
      }
    }
    throw new Error("No downloadable video stream found on this X/Twitter post");
  }

  if (platform === "vimeo") {
    const vidMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (vidMatch) {
      const cfg = await fetchJson<{
        request?: { files?: { progressive?: Array<{ url?: string; height?: number }> } };
      }>(`https://player.vimeo.com/video/${vidMatch[1]}/config`, 7000);
      const prog = [...(cfg?.request?.files?.progressive || [])]
        .filter((p) => p.url && (p.height || 720) <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (prog[0]?.url) return { videoUrl: prog[0].url };
    }
    throw new Error("Could not resolve progressive Vimeo MP4 stream");
  }

  if (platform === "reddit") {
    const fullUrl = url.includes("redd.it") ? await resolveRedirect(url) : url;
    const cleanPath = fullUrl.split("?")[0].replace(/\/+$/, "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await fetchJson<any[]>(`${cleanPath}.json?raw_json=1`, 7000, {
      "User-Agent": "MediaSphere/1.0 (RealMediaExtractor)",
    });
    const post = data?.[0]?.data?.children?.[0]?.data;
    const rv = post?.secure_media?.reddit_video || post?.media?.reddit_video;
    if (rv?.fallback_url) {
      const videoUrl = String(rv.fallback_url).split("?")[0];
      const baseMedia = videoUrl.substring(0, videoUrl.lastIndexOf("/"));
      return {
        videoUrl,
        audioUrl: `${baseMedia}/DASH_AUDIO_128.mp4`,
      };
    }
    throw new Error("No Reddit hosted video found on this post");
  }

  // Generic OpenGraph og:video / JSON-LD contentUrl fallback
  const html =
    (await fetchHtml(url, 7000, "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")) ||
    (await fetchHtml(url, 7000, BROWSER_UA));
  if (html) {
    const ogVideo =
      extractMetaTag(html, "og:video:secure_url") ||
      extractMetaTag(html, "og:video:url") ||
      extractMetaTag(html, "og:video");
    if (ogVideo && ogVideo.startsWith("http")) {
      return { videoUrl: ogVideo };
    }
    const contentUrlMatch = html.match(/"contentUrl"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/i);
    if (contentUrlMatch?.[1]) {
      return { videoUrl: contentUrlMatch[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/") };
    }
  }

  throw new Error(`Direct stream download is restricted or unavailable for this ${platform} URL`);
}
