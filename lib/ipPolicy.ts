/**
 * Shared IP/host policy for outbound SSRF protection.
 *
 * This module is pure (no Node network APIs) so it can be reused by the
 * client/server URL sanitizer and the server-side outbound guard.
 */
import ipaddr from "ipaddr.js";

export const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

/** Strip URL brackets, trailing dots and lowercase a hostname. */
export function normalizeHost(rawHost: string): string {
  return rawHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

/**
 * True when the literal IP address must never be contacted.
 *
 * IPv4-mapped IPv6 addresses are unwrapped and classified as their IPv4
 * counterpart. Non-unicast IPv6 ranges (6to4, Teredo, multicast, documentation,
 * unique-local, link-local, loopback, unspecified) are blocked.
 */
export function isBlockedIp(rawIp: string): boolean {
  const host = normalizeHost(rawIp);
  if (!host) return true;
  try {
    // process() converts IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4.
    const original = ipaddr.parse(host);
    if (original.kind() === "ipv6") {
      const v6 = original as ipaddr.IPv6;
      if (!v6.isIPv4MappedAddress() && v6.match(ipaddr.parse("::") as ipaddr.IPv6, 96)) return true;
    }
    const addr = ipaddr.process(host);
    return addr.range() !== "unicast";
  } catch {
    // Not a literal IP; caller must resolve DNS and classify every answer.
    return false;
  }
}

/** True for hostnames that are known internal names or literal blocked IPs. */
export function isBlockedHost(rawHost: string): boolean {
  const host = normalizeHost(rawHost);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".localdomain")) return true;
  return isBlockedIp(host);
}
