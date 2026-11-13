/** Server-only outbound HTTP guard. All DNS answers are checked at connection time. */
import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";
import { isBlockedHost, isBlockedIp, normalizeHost } from "./ipPolicy";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export function assertPublicHttpUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw.toString());
  } catch {
    throw new SsrfBlockedError("Invalid outbound URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || isBlockedHost(url.hostname)) {
    throw new SsrfBlockedError("Blocked outbound URL");
  }
  return url;
}

// Resolve every address family, not just the one selected by the HTTP client.
// Return only the validated addresses to the socket, avoiding a second DNS lookup.
export const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  const host = normalizeHost(hostname);
  if (isBlockedHost(host)) {
    callback(new SsrfBlockedError(`Blocked internal host: ${host}`), "", 0);
    return;
  }
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      callback(new SsrfBlockedError("DNS lookup timed out"), "", 0);
    }
  }, 10000);
  dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (err) return callback(err, "", 0);
    if (!addresses.length || addresses.some(({ address }) => !net.isIP(address) || isBlockedIp(address))) {
      return callback(new SsrfBlockedError(`Blocked DNS answer for ${host}`), "", 0);
    }
    const selected = options.family ? addresses.filter((a) => a.family === options.family) : addresses;
    if (!selected.length) return callback(Object.assign(new Error("No address for requested family"), { code: "ENOTFOUND" }), "", 0);
    if (options.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  });
};

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 10000 } });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Fetch-compatible guard: revalidate each redirect, pin DNS at socket connect. */
export const safeFetch: typeof fetch = async (input, init) => {
  let request = new Request(input, init);
  const mode = request.redirect;
  for (let hop = 0; hop <= 5; hop++) {
    const url = assertPublicHttpUrl(request.url);
    if (request.headers.has("host") || request.headers.has("proxy-authorization")) {
      throw new SsrfBlockedError("Unsafe outbound request headers");
    }
    // Node's fetch accepts an undici dispatcher; DOM types do not expose it.
    const response = await fetch(request.clone(), { redirect: "manual", dispatcher: agent } as RequestInit);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || mode === "manual") return response;
    await response.body?.cancel();
    if (mode === "error") throw new TypeError("Redirect is not allowed");
    if (hop === 5) throw new TypeError("Too many redirects");
    const next = assertPublicHttpUrl(new URL(location, url));
    const headers = new Headers(request.headers);
    if (url.origin !== next.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    const changeMethod = (response.status === 303 && request.method !== "GET" && request.method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && request.method === "POST");
    if (changeMethod) {
      headers.delete("content-type");
      headers.delete("content-length");
      request = new Request(next, { method: "GET", headers, signal: request.signal, redirect: mode });
    } else {
      request = new Request(next, { method: request.method, headers, body: request.body, signal: request.signal, redirect: mode, ...(request.body ? { duplex: "half" } : {}) } as RequestInit);
    }
  }
  throw new TypeError("Too many redirects");
};
