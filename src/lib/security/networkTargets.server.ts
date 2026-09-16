/**
 * Network destination classification (CRB-09 / Issue #10).
 *
 * Saving a Provider result, importing remote media or following a redirect must
 * never become a way to reach loopback, private, link-local, carrier-grade-NAT,
 * multicast or cloud-metadata services from the server process. Every address a
 * destination can resolve to is classified before a connection is made.
 *
 * Loopback and private IPv6 forms are covered too, including IPv4-mapped and
 * NAT64/6to4 embeddings, because `::ffff:169.254.169.254` reaches the same
 * metadata service as the dotted form.
 */

import { promises as dns } from "node:dns";

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "unique-local"
  | "carrier-grade-nat"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "metadata";

function classifyIpv4(address: string): AddressClass {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "reserved";
  }
  const [a, b] = parts;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "metadata";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 192 && b === 0 && parts[2] === 0) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  return "public";
}

/** Expand an IPv6 literal into eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const literal = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const halves = literal.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const groups: number[] = [];
    for (const raw of segment.split(":")) {
      if (raw.length === 0) return null;
      // Trailing dotted-quad form, e.g. ::ffff:127.0.0.1
      if (raw.includes(".")) {
        const mapped = raw.split(".").map((part) => Number.parseInt(part, 10));
        if (mapped.length !== 4 || mapped.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
          return null;
        }
        groups.push(((mapped[0] << 8) | mapped[1]) & 0xffff, ((mapped[2] << 8) | mapped[3]) & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

function ipv4FromGroups(groups: number[]): string {
  return [groups[0] >> 8, groups[0] & 0xff, groups[1] >> 8, groups[1] & 0xff].join(".");
}

function classifyIpv6(address: string): AddressClass {
  const groups = expandIpv6(address);
  if (!groups) return "reserved";
  const allZero = groups.every((group) => group === 0);
  if (allZero) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible forms reach IPv4 directly.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return classifyIpv4(ipv4FromGroups(groups.slice(6)));
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return classifyIpv4(ipv4FromGroups(groups.slice(6)));
  }
  // 6to4 2002::/16 embeds an IPv4 address in the first 32 bits after the prefix.
  if (groups[0] === 0x2002) {
    const embedded = classifyIpv4(ipv4FromGroups([groups[1], groups[2]]));
    return embedded === "public" ? "reserved" : embedded;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return "unique-local";
  if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((groups[0] & 0xff00) === 0xff00) return "multicast";
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return "reserved";
  return "public";
}

/** Classify an IP literal. Dotted and IPv6 forms are both accepted. */
export function classifyAddress(address: string): AddressClass {
  const literal = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (literal.includes(":")) return classifyIpv6(literal);
  return classifyIpv4(literal);
}

export interface AddressPolicy {
  /**
   * Allow loopback destinations. Only the explicitly configured local ComfyUI
   * engine and local test doubles set this; provider media never does.
   */
  allowLoopback?: boolean;
  /** Allow private (RFC1918 / ULA) destinations, for a user-declared LAN engine. */
  allowPrivate?: boolean;
  /**
   * Address classes that count as "the user's own machines" for a destination
   * the user declared. Cloud metadata, link-local, multicast, reserved and
   * unspecified addresses are never reachable through this, whichever flag a
   * caller sets — a local engine setting must not become a route to
   * `169.254.169.254`.
   */
  allowedNonPublicClasses?: readonly AddressClass[];
}

/** The classes a user-declared engine (local box or LAN host) may reach. */
export const LOCAL_ENGINE_ADDRESS_CLASSES: readonly AddressClass[] = [
  "loopback",
  "private",
  "unique-local",
  "carrier-grade-nat",
];

/** True when no connection may be made to this address under the policy. */
export function isDisallowedAddress(address: string, policy: AddressPolicy = {}): boolean {
  const kind = classifyAddress(address);
  if (kind === "public") return false;
  if (policy.allowedNonPublicClasses?.includes(kind)) return false;
  if (kind === "loopback") return !policy.allowLoopback;
  if (kind === "private" || kind === "unique-local") return !policy.allowPrivate;
  return true;
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: every A/AAAA answer for the host. */
export const systemAddressResolver: AddressResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

let resolverOverride: AddressResolver | null = null;

/**
 * The resolver the download and outbound seams use when the caller does not
 * pass one. Tests replace it so no automated run performs real DNS.
 */
export function activeAddressResolver(): AddressResolver {
  return resolverOverride ?? systemAddressResolver;
}

/** Test seam: pin (or clear) the process-wide resolver. */
export function setAddressResolverForTest(resolver: AddressResolver | null): void {
  resolverOverride = resolver;
}

/** True when the hostname is an IP literal rather than a name to resolve. */
function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":") && expandIpv6(hostname) !== null;
}

export interface TargetCheck {
  ok: boolean;
  addresses: string[];
  blocked?: { address: string; kind: AddressClass };
  reason?: "invalid-url" | "blocked-protocol" | "blocked-address" | "resolution-failed";
}

/**
 * Validate one hop's destination: scheme, then every address it resolves to.
 * A host that resolves to any blocked address is rejected outright rather than
 * picking a permitted answer, because the caller cannot choose which one a
 * later connection will use.
 */
export async function checkNetworkTarget(
  url: string,
  policy: AddressPolicy & { resolve?: AddressResolver; allowHttp?: boolean } = {},
): Promise<TargetCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, addresses: [], reason: "invalid-url" };
  }
  if (parsed.protocol !== "https:" && !(policy.allowHttp && parsed.protocol === "http:")) {
    return { ok: false, addresses: [], reason: "blocked-protocol" };
  }

  const hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;

  let addresses: string[];
  if (isIpLiteral(hostname)) {
    addresses = [hostname];
  } else {
    const resolve = policy.resolve ?? activeAddressResolver();
    try {
      addresses = await resolve(hostname);
    } catch {
      return { ok: false, addresses: [], reason: "resolution-failed" };
    }
    if (addresses.length === 0) {
      return { ok: false, addresses: [], reason: "resolution-failed" };
    }
  }

  for (const address of addresses) {
    if (isDisallowedAddress(address, policy)) {
      return {
        ok: false,
        addresses,
        blocked: { address, kind: classifyAddress(address) },
        reason: "blocked-address",
      };
    }
  }
  return { ok: true, addresses };
}

/** Same-origin comparison that treats `https://h:443` and `https://h` as equal. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when `url`'s origin is one of `origins`. */
export function originInList(url: string, origins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && origins.includes(origin);
}
