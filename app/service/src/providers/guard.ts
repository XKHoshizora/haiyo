import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { AppError } from "../errors.ts";
import type { Slots } from "../slots.ts";

/**
 * The address guard. Every request the service makes to a host a user named (their providers' `baseUrl`) goes
 * through `guardedFetch`, and nothing else in the service opens a connection to such a host. The model gateway sends
 * site models' calls through it too, so every model call obeys the same rules and the same cap.
 */

// --- which addresses are public ---------------------------------------------------------------------------

/** Dotted-decimal IPv4 (no leading zeros, nothing shortened) as four octets, or null. */
function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return null;
    octets.push(Number(p));
  }
  return octets;
}

/** An IPv6 address as eight 16-bit groups, or null. A zone (`%eth0`) is ignored; a dotted IPv4 tail is allowed. */
function parseIPv6(s: string): number[] | null {
  const address = s.split("%")[0]!;
  if (!address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const items = part.split(":");
    const out: number[] = [];
    for (const [i, item] of items.entries()) {
      if (last && i === items.length - 1 && item.includes(".")) {
        const v4 = parseIPv4(item);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(item)) {
        out.push(parseInt(item, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  if (halves.length === 1) {
    const all = groups(halves[0]!, true);
    return all && all.length === 8 ? all : null;
  }
  const head = groups(halves[0]!, false);
  const tail = groups(halves[1]!, true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** IPv4 ranges that are not the public internet: [first address, prefix length]. */
const NOT_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = (
  [
    ["0.0.0.0", 8], // "this network", the unspecified address
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local (cloud metadata services live here)
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation (TEST-NET-1)
    ["192.88.99.0", 24], // deprecated 6to4 relay anycast
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation (TEST-NET-2)
    ["203.0.113.0", 24], // documentation (TEST-NET-3)
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, and the broadcast address 255.255.255.255
  ] as const
).map(([base, bits]) => [v4Number(parseIPv4(base)!), bits] as const);

function v4Number(o: number[]): number {
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

function publicV4(n: number): boolean {
  return !NOT_PUBLIC_V4.some(([base, bits]) => (n & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0 === base);
}

/** The IPv4 address carried in two 16-bit groups. */
const embedded = (high: number, low: number): number => ((high << 16) | low) >>> 0;

function publicV6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:0:0/96: judged by the IPv4 address inside.
  if (zero(0, 5) && g[5] === 0xffff) return publicV4(embedded(g[6]!, g[7]!));
  // One rule for the rest: only global unicast 2000::/3 minus the special ranges inside it. Everything outside it is
  // refused, which covers ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0:0/96 (IPv4-translated),
  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), 100::/64 (discard), fc00::/7, fe80::/10, fec0::/10 and ff00::/8.
  const first = g[0]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false; // 2002::/16 6to4 (embeds an IPv4 address)
  if (first === 0x2001) {
    const second = g[1]!;
    if (second === 0) return false; // 2001::/32 Teredo
    if (second === 0x0db8) return false; // 2001:db8::/32 documentation
    if ((second & 0xfff0) === 0x0010) return false; // 2001:10::/28 ORCHID
    if ((second & 0xfff0) === 0x0020) return false; // 2001:20::/28 ORCHIDv2
    if (second === 2 && g[2] === 0) return false; // 2001:2::/48 benchmarking
  }
  return true;
}

/**
 * Whether `address` (IPv4 or IPv6 text) is a public internet address: not loopback, private, link-local,
 * carrier-grade NAT, unspecified, multicast, reserved, benchmarking or documentation (every IPv4 special-purpose range), nor an IPv4-mapped form of one of those.
 * An IPv6 address is public only inside 2000::/3 and outside its special ranges (Teredo, 6to4, documentation,
 * ORCHID, benchmarking); NAT64, IPv4-translated and IPv4-compatible forms are refused outright. Anything that does not parse as an address is not public.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return publicV4(v4Number(v4));
  const v6 = parseIPv6(address);
  return v6 ? publicV6(v6) : false;
}

/** 127.0.0.0/8 or ::1: what `allowInsecureLocal` lets through. */
function isLoopbackAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return v4[0] === 127;
  const v6 = parseIPv6(address);
  return v6 !== null && v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1;
}

// --- which URLs may be called ---------------------------------------------------------------------------------

/** A plain DNS name as the URL parser leaves it (lower case, IDNA to punycode): letters, digits, inner hyphens, dots. */
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A URL's host without the brackets of an IPv6 literal. */
const bareHost = (url: URL): string => (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname);

/**
 * `raw` as a URL a provider may be called at, or null: it parses; it is `https:` (also `http:` with
 * `allowInsecureLocal`); it carries no credentials (no `@` before the host at all); its host is a plain DNS name
 * or an IP address; a port, if named, is 1–65535 (the parser refuses larger ones). Whether the address is
 * allowed is decided when it is called.
 */
function parseProviderUrl(raw: string, allowInsecureLocal: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowInsecureLocal && url.protocol === "http:")) return null;
  if (url.username !== "" || url.password !== "") return null;
  // `https://@host` parses with empty credentials: an `@` anywhere before the host is refused too.
  const authority = /^[a-z][a-z0-9+.-]*:[\\/]*([^\\/?#]*)/i.exec(raw.trim())?.[1] ?? "";
  if (authority.includes("@")) return null;
  const host = bareHost(url);
  if (net.isIP(host) === 0 && !DNS_NAME.test(host)) return null;
  if (url.port !== "" && Number(url.port) < 1) return null;
  return url;
}

/**
 * A provider's `baseUrl` as stored: checked for scheme and syntax as `parseProviderUrl` does, then without
 * query, fragment or trailing slash (`https://API.example.com:443/v1/?x#y` → `https://api.example.com/v1`).
 * Null when it may not be one.
 */
export function normaliseBaseUrl(raw: string, allowInsecureLocal: boolean): string | null {
  const url = parseProviderUrl(raw.trim(), allowInsecureLocal);
  return url ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : null;
}

// --- the fetch ----------------------------------------------------------------------------------------------------

/** How the guard looks a name up: `dns.promises.lookup` with `{ all: true }` (the default), or a test's own. */
export type Resolve = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

/** The one key calls are counted under (`GuardOptions.calls`): the cap is for everyone together. */
const SITE = "site";

export interface GuardOptions {
  resolve?: Resolve;
  /** The response body may be at most this long (after decoding); one byte more aborts the request. */
  maxResponseBytes: number;
  /**
   * The request is aborted when this long passes without progress: until the headers, then from the headers to the
   * first body chunk and between body chunks. The total duration is the caller's to bound (`init.signal`).
   */
  timeoutMs: number;
  /**
   * How long finding the address and connecting to it (TCP and TLS) may take, for a guard whose `timeoutMs` is long
   * because what it calls may rightly be silent for long (a model that may think: models/gateway.ts): an address that
   * cannot be reached is still given up on after this. Default `timeoutMs`.
   */
  connectTimeoutMs?: number;
  /**
   * Where calls in flight are counted, one slot each from before the name lookup until the call is over (body read,
   * cancelled, failed, aborted or timed out); a call that finds no slot is `provider_unavailable` at once. In the app:
   * one count for the whole service (one process), `createSlots(PROVIDER_MAX_CONCURRENT_CALLS)`, which `buildApp` makes
   * from the configuration and hands to every guard it builds. Tests pass their own.
   */
  calls: Slots;
  /**
   * Tests only, through `BuildOptions` (never from configuration): loopback addresses are allowed, and `http:`
   * to them. Every other rule stands.
   */
  allowInsecureLocal?: boolean;
}

/**
 * TCP keepalive on every outbound connection: after this long without a byte either way the system starts probing the
 * peer, and a peer that no longer answers ends the connection (the call then fails `provider_unavailable`, as any
 * connection that dies). It is what finds a silently dead peer while a model that may think is rightly silent, where no
 * no-progress timer applies (models/gateway.ts). Node exposes the idle time alone (`net` `keepAlive` /
 * `keepAliveInitialDelay`, `socket.setKeepAlive`, which undici's connector takes); how often and how many times the
 * system probes after it is libuv's: on Linux `TCP_KEEPINTVL` 10 s and `TCP_KEEPCNT` 1 (libuv 1.50, Node 24), so a dead
 * peer is found about 40 s after its last byte. A proxy in between answers the probes itself: then only the ceiling ends
 * a call that never answers.
 */
export const KEEPALIVE_IDLE_MS = 30_000;

export const addressNotAllowed = (): AppError => new AppError(400, "address_not_allowed");
export const providerUnavailable = (): AppError => new AppError(502, "provider_unavailable");

/**
 * `provider_unavailable` for a call the guard itself gave up on, saying why (`gaveUp`): the answer passed
 * `maxResponseBytes`, or `timeoutMs` passed without progress. Answered and logged as any `provider_unavailable`; a caller
 * that counts its failures by kind reads why (the judgement client's `JudgeError.reason`).
 */
export class GuardGaveUp extends AppError {
  constructor(readonly gaveUp: "oversize" | "stalled") {
    super(502, "provider_unavailable");
  }
}

/** `promise`, or the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The addresses `url` may be dialled at: its literal address, or every address its name resolves to (looked up
 * once). Refused (`address_not_allowed`) if any of them is not public (loopback passes with `allowInsecureLocal`),
 * or if the URL is `http:` and they are not all loopback. A name that does not resolve is `provider_unavailable`.
 */
async function checkedAddresses(url: URL, resolve: Resolve, local: boolean, signal: AbortSignal): Promise<LookupAddress[]> {
  const host = bareHost(url);
  let found: LookupAddress[];
  if (net.isIP(host) !== 0) {
    found = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      found = await abortable(resolve(host, { all: true }), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw providerUnavailable();
    }
    if (!Array.isArray(found) || found.length === 0) throw providerUnavailable();
  }
  const checked = found.map((a) => ({ address: String(a.address), family: net.isIP(String(a.address)) }));
  for (const a of checked) {
    if (a.family === 0) throw addressNotAllowed();
    if (!isPublicAddress(a.address) && !(local && isLoopbackAddress(a.address))) throw addressNotAllowed();
  }
  if (url.protocol === "http:" && !checked.every((a) => isLoopbackAddress(a.address))) throw addressNotAllowed();
  return checked;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for `net.connect` that answers only with the addresses already checked: no second resolution. */
function pinnedLookup(addresses: LookupAddress[]) {
  return (_hostname: string, options: { family?: number | string; all?: boolean }, callback: LookupCallback): void => {
    const wanted = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : Number(options.family) || 0;
    const usable = wanted === 0 ? addresses : addresses.filter((a) => a.family === wanted);
    if (usable.length === 0) {
      callback(Object.assign(new Error("no checked address of the requested family"), { code: "ENOTFOUND" }), "");
    } else if (options.all) {
      callback(null, usable);
    } else {
      callback(null, usable[0]!.address, usable[0]!.family);
    }
  };
}

/** Statuses whose response has no body. */
const NULL_BODY_STATUS = new Set([204, 205]);

/**
 * A `fetch` for calling users' providers. For each request: the URL must pass `parseProviderUrl` (https, no
 * credentials, a plain host, a sane port); a slot among the calls in flight must be free (`GuardOptions.calls`, else
 * `provider_unavailable` at once); the host is resolved once and every address checked (`checkedAddresses`); the
 * connection is made to exactly those addresses (the name stays the Host and TLS SNI); redirects are never followed
 * (any 3xx is `provider_unavailable`); the request is aborted after `timeoutMs` without progress (re-armed when the
 * headers arrive and at every body chunk; until the address is found and connected to, after `connectTimeoutMs` when
 * that is given) and when the body passes `maxResponseBytes` (`provider_unavailable`, as `GuardGaveUp` saying which).
 * Refusals are `AppError(400, "address_not_allowed")` and happen before any connection. Errors never carry the
 * upstream's body or headers, nor the request's. An abort by the caller's own `signal` passes through as that abort
 * and closes the connection at once, whether or not the body is being read.
 */
export function guardedFetch(opts: GuardOptions): typeof fetch {
  const resolve: Resolve = opts.resolve ?? ((hostname, options) => dns.lookup(hostname, options));
  const local = opts.allowInsecureLocal === true;
  const { calls } = opts;
  const connectTimeoutMs = opts.connectTimeoutMs ?? opts.timeoutMs;

  async function guarded(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("guardedFetch takes a URL or a string, not a Request");
    const url = parseProviderUrl(typeof input === "string" ? input : input.href, local);
    if (!url) throw addressNotAllowed();
    if (calls.take(SITE) !== "taken") throw providerUnavailable();

    // From here on `finish` gives the slot back, exactly once, however the call ends.
    const own = new AbortController();
    const signal = init.signal ? AbortSignal.any([own.signal, init.signal]) : own.signal;
    let agent: Agent | undefined;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let timedOut = false;
    /** Ends the request for good: no timer, no connection, the slot given back. Idempotent. */
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      if (agent) void agent.destroy().catch(() => {});
      calls.release(SITE);
    };
    /** (Re)starts the "no progress for timeoutMs" timer (`ms`: for another wait than `timeoutMs`). */
    const arm = (ms = opts.timeoutMs) => {
      if (finished) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        own.abort();
        finish();
      }, ms);
    };
    /**
     * The caller's own abort stays that abort; the guard's errors stay; no progress in time is `GuardGaveUp` `stalled`;
     * anything else is `provider_unavailable`.
     */
    const failure = (err: unknown): unknown => {
      if (!timedOut && init.signal?.aborted) return init.signal.reason;
      return err instanceof AppError ? err : timedOut ? new GuardGaveUp("stalled") : providerUnavailable();
    };

    /** The upstream body, counted and timed. */
    const limited = (upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
      const reader = upstream.getReader();
      let received = 0;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                finish();
                controller.close();
                return;
              }
              received += value.byteLength;
              if (received > opts.maxResponseBytes) throw new GuardGaveUp("oversize");
              arm();
              controller.enqueue(value);
            } catch (err) {
              finish();
              controller.error(failure(err));
            }
          },
          cancel(reason) {
            finish();
            return reader.cancel(reason).catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
    };

    arm(connectTimeoutMs);
    // An abort (the caller's, or the timer's) ends the call at once, even while nobody reads the body.
    signal.addEventListener("abort", finish, { once: true });
    try {
      const addresses = await checkedAddresses(url, resolve, local, signal);
      signal.throwIfAborted();
      arm(); // the address is found: from here the wait is for the answer (connecting has its own limit, below)
      agent = new Agent({
        allowH2: false,
        connections: 1,
        headersTimeout: 0, // the guard's own timer governs
        bodyTimeout: 0,
        connect: { lookup: pinnedLookup(addresses), timeout: connectTimeoutMs, keepAlive: true, keepAliveInitialDelay: KEEPALIVE_IDLE_MS },
      });
      const res = await undiciFetch(url.href, { ...(init as UndiciRequestInit), signal, redirect: "manual", dispatcher: agent });
      arm(); // the headers are progress: the first body chunk gets a full `timeoutMs`
      if (res.status >= 300 && res.status < 400) throw providerUnavailable();
      const declared = res.headers.get("content-length");
      if (declared !== null && Number(declared) > opts.maxResponseBytes) throw new GuardGaveUp("oversize");
      const headers = new Headers(res.headers as unknown as HeadersInit);
      if (res.body === null || NULL_BODY_STATUS.has(res.status)) {
        finish();
        return new Response(null, { status: res.status, headers });
      }
      return new Response(limited(res.body as ReadableStream<Uint8Array>), { status: res.status, headers });
    } catch (err) {
      finish();
      throw failure(err);
    }
  }

  return guarded as typeof fetch;
}
