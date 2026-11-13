import assert from "node:assert/strict";
import dns from "node:dns";
import test from "node:test";
import { assertPublicHttpUrl, safeFetch, safeLookup } from "../lib/outboundSecurity";
import { isBlockedIp } from "../lib/ipPolicy";
import { validateUrl } from "../lib/sanitizer";

test("rejects special-use addresses, alternate literal forms and credentials", () => {
  for (const url of ["http://127.1/", "http://2130706433/", "http://[::ffff:127.0.0.1]/", "http://100.64.0.1/", "http://[::8.8.8.8]/", "http://localhost./", "http://metadata.google.internal/", "file:///etc/passwd", "https://user@youtube.com/"]) {
    assert.throws(() => assertPublicHttpUrl(url), url);
  }
  for (const ip of ["198.18.0.1", "224.0.0.1", "2001:db8::1", "192.88.99.1"]) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "2001:4860:4860::8888"]) assert.equal(isBlockedIp(ip), false, ip);
  assert.equal(validateUrl("https://user@youtube.com/watch?v=dQw4w9WgXcQ").valid, false);
});

test("lookup rejects mixed public/private DNS answers and returns pinned public addresses", async () => {
  const original = dns.lookup;
  try {
    let answers = [{address: "8.8.8.8", family: 4}, {address: "127.0.0.1", family: 4}];
    dns.lookup = ((...args: unknown[]) => { const cb = args[2] as (e: null, a: typeof answers) => void; cb(null, answers); }) as typeof dns.lookup;
    const lookup = () => new Promise<{err: Error | null; result: unknown}>((resolve) => safeLookup("public.example", { all: true }, (err, result) => resolve({err, result})));
    assert.ok((await lookup()).err);
    answers = [{address: "8.8.8.8", family: 4}, {address: "1.1.1.1", family: 4}];
    assert.deepEqual((await lookup()).result, answers);
  } finally { dns.lookup = original; }
});

test("manual redirect handling blocks internal targets and bounds hops", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      calls.push((input as Request).url);
      return new Response(null, {status: 302, headers: {location: "http://127.0.0.1/secret"}});
    };
    await assert.rejects(safeFetch("https://public.example/"), /Blocked/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response(null, {status: 302, headers: {location: "/again"}});
    await assert.rejects(safeFetch("https://public.example/"), /Too many redirects/);
    const response = await safeFetch("https://public.example/", {redirect: "manual"});
    assert.equal(response.status, 302);
    await assert.rejects(safeFetch("https://public.example/", {redirect: "error"}), /Redirect/);
  } finally { globalThis.fetch = original; }
});

test("redirect changes POST to GET and strips cross-origin credentials", async () => {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  try {
    globalThis.fetch = async (input) => {
      calls.push(input as Request);
      return calls.length === 1 ? new Response(null, {status: 302, headers: {location: "https://other.example/"}}) : new Response("ok");
    };
    await safeFetch("https://public.example/", {method: "POST", body: "hello", headers: {authorization: "secret", cookie: "secret=1"}});
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].headers.get("authorization"), null);
    assert.equal(calls[1].headers.get("cookie"), null);
  } finally { globalThis.fetch = original; }
});

test("real HTTP transport rejects DNS rebinding before connecting", async () => {
  const original = dns.lookup;
  try {
    dns.lookup = ((...args: unknown[]) => {
      const cb = args[2] as (e: null, a: {address: string; family: number}[]) => void;
      cb(null, [{address: "8.8.8.8", family: 4}, {address: "127.0.0.1", family: 4}]);
    }) as typeof dns.lookup;
    await assert.rejects(safeFetch("http://rebind.example/", {signal: AbortSignal.timeout(3000)}), /fetch failed/);
  } finally { dns.lookup = original; }
});

test("HLS staging validates segment URLs and removes partial files", async () => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stageHlsMedia } = await import("../lib/hlsStaging");
  const directory = await mkdtemp(join(tmpdir(), "ms-hls-"));
  const dest = join(directory, "media");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = (input as Request).url;
      if (url.endsWith("master.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n");
      if (url.endsWith("media.m3u8")) return new Response("#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n");
      return new Response(new Uint8Array(300).fill(42));
    };
    await stageHlsMedia("https://public.example/master.m3u8", dest);
    assert.equal((await readFile(dest)).length, 300);
    globalThis.fetch = async () => new Response("#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1/secret\n#EXT-X-ENDLIST\n");
    await assert.rejects(stageHlsMedia("https://public.example/media.m3u8", dest), /Blocked/);
    await assert.rejects(stat(dest));
    globalThis.fetch = async () => new Response("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXTINF:1,\nx.ts\n#EXT-X-ENDLIST\n");
    await assert.rejects(stageHlsMedia("https://public.example/media.m3u8", dest), /Unsupported/);
  } finally {
    globalThis.fetch = original;
    await rm(directory, {recursive: true, force: true});
  }
});

test("FFmpeg can process a securely staged MPEG-TS HLS playlist", async () => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { default: ffmpeg } = await import("@ffmpeg-installer/ffmpeg");
  const { stageHlsMedia } = await import("../lib/hlsStaging");
  const directory = await mkdtemp(join(tmpdir(), "ms-hls-ffmpeg-"));
  const original = globalThis.fetch;
  try {
    const ts = join(directory, "segment.ts");
    execFileSync(ffmpeg.path, ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:duration=1:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", ts], {stdio: "ignore"});
    const bytes = await readFile(ts);
    globalThis.fetch = async (input) => (input as Request).url.endsWith(".m3u8")
      ? new Response("#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n")
      : new Response(bytes);
    const staged = join(directory, "staged.media");
    const output = join(directory, "output.mp4");
    await stageHlsMedia("https://public.example/media.m3u8", staged);
    execFileSync(ffmpeg.path, ["-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,mp3,wav,ogg,flac,mpegts,aac,mpeg,avi,m4v", "-i", staged, "-c", "copy", output], {stdio: "ignore"});
    assert.ok((await stat(output)).size > 512);
  } finally {
    globalThis.fetch = original;
    await rm(directory, {recursive: true, force: true});
  }
});
