import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors.ts";
import { guardedFetch, isPublicAddress, KEEPALIVE_IDLE_MS, normaliseBaseUrl, type Resolve } from "../src/providers/guard.ts";
import { createSlots } from "../src/slots.ts";

/**
 * The address guard (`src/providers/guard.ts`): every request to a user-supplied host goes through it. These
 * tests use local listeners and an injected resolver; nothing leaves the machine except, in the rebinding test,
 * one connection attempt to a documentation address (203.0.113.0/24, never routed) that times out.
 */

const refused = { status: 400, code: "address_not_allowed" };
const unavailable = { status: 502, code: "provider_unavailable" };
/** A count of calls in flight with room to spare, for tests that are not about the cap. */
const room = () => createSlots(64);

/** A resolver that answers from a script (the last answer repeats) and records the names it was asked. */
function scriptedResolver(...answers: string[][]): Resolve & { calls: string[] } {
  const calls: string[] = [];
  const resolve: Resolve = async (hostname) => {
    calls.push(hostname);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? [];
    return answer.map((address) => ({ address, family: net.isIP(address) }));
  };
  return Object.assign(resolve, { calls });
}

const open: Array<net.Server> = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    if (s instanceof http.Server) s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
});

/** An HTTP server on `host`, counting the TCP connections it accepts. */
async function listener(handler: http.RequestListener = (_req, res) => res.end("ok"), host = "127.0.0.1") {
  let connections = 0;
  const server = http.createServer(handler);
  server.on("connection", () => connections++);
  await new Promise<void>((ok) => server.listen(0, host, ok));
  open.push(server);
  return { port: (server.address() as net.AddressInfo).port, connections: () => connections };
}

const settle = async (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => e);

describe("isPublicAddress (the one range check)", () => {
  const CASES: Array<[string, boolean]> = [
    // IPv4: public
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["93.184.216.34", true],
    ["100.63.255.255", true],
    ["100.128.0.0", true],
    ["172.15.255.255", true],
    ["172.32.0.0", true],
    ["192.0.1.1", true],
    ["192.169.0.1", true],
    ["198.17.255.255", true],
    ["198.20.0.0", true],
    ["223.255.255.255", true],
    // IPv4: not public
    ["0.0.0.0", false],
    ["0.1.2.3", false],
    ["10.0.0.5", false],
    ["10.255.255.255", false],
    ["100.64.0.1", false],
    ["100.127.255.255", false],
    ["127.0.0.1", false],
    ["127.255.255.254", false],
    ["169.254.169.254", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["192.0.0.1", false],
    ["192.0.0.255", false],
    ["192.168.1.1", false],
    ["198.18.0.1", false],
    ["198.19.255.255", false],
    ["224.0.0.1", false],
    ["239.255.255.255", false],
    ["240.0.0.1", false],
    ["255.255.255.255", false],
    ["192.0.3.1", true],
    ["198.51.101.1", true],
    ["203.0.114.1", true],
    ["198.51.99.255", true],
    ["198.17.255.255", true],
    ["198.20.0.1", true],
    ["192.0.1.1", true],
    ["192.88.98.1", true],
    ["192.88.100.1", true],
    ["192.0.3.0", true],
    ["203.0.112.255", true],
    ["192.167.255.255", true],
    ["0.0.0.0", false],
    ["0.255.255.255", false],
    ["10.0.0.0", false],
    ["10.255.255.255", false],
    ["100.64.0.0", false],
    ["100.127.255.255", false],
    ["127.0.0.0", false],
    ["127.255.255.255", false],
    ["169.254.0.0", false],
    ["169.254.255.255", false],
    ["172.16.0.0", false],
    ["172.31.255.255", false],
    ["192.0.0.0", false],
    ["192.0.0.255", false],
    ["192.0.2.0", false],
    ["192.0.2.1", false],
    ["192.0.2.255", false],
    ["192.88.99.0", false],
    ["192.88.99.255", false],
    ["192.168.0.0", false],
    ["192.168.255.255", false],
    ["198.18.0.0", false],
    ["198.19.255.255", false],
    ["198.51.100.0", false],
    ["198.51.100.255", false],
    ["203.0.113.0", false],
    ["203.0.113.7", false],
    ["203.0.113.255", false],
    ["224.0.0.0", false],
    ["239.255.255.255", false],
    ["240.0.0.0", false],
    ["255.255.255.255", false],
    ["::ffff:192.0.2.1", false],
    ["::ffff:203.0.113.5", false],
    // IPv6: public
    ["2001:4860:4860::8888", true],
    ["2606:4700:4700::1111", true],
    ["2a00:1450:4001:81b::200e", true],
    ["2001:4800::1", true],
    ["2001:1::1", true],
    ["2001:30::1", true],
    ["2001:2:1::1", true],
    ["2001:db9::1", true],
    ["2003::1", true],
    ["::ffff:8.8.8.8", true],
    ["::ffff:808:808", true],
    // IPv6: not public
    ["::", false],
    ["::1", false],
    ["0:0:0:0:0:0:0:1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["FD00::1", false],
    ["fe80::1", false],
    ["febf::1", false],
    ["fec0::1", false],
    ["fe80::1%eth0", false],
    ["ff02::1", false],
    ["ff00::", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:a00:1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false],
    ["::ffff:0:0", false],
    ["64:ff9b::7f00:1", false],
    ["64:ff9b::10.0.0.1", false],
    ["64:ff9b::a9fe:a9fe", false],
    ["64:ff9b:1::8.8.8.8", false],
    ["::127.0.0.1", false],
    ["::10.0.0.1", false],
    ["2002:a00:1::1", false],
    ["2002:7f00:1::", false],
    ["64:ff9b::8.8.8.8", false],
    ["64:ff9b:1:2::3", false],
    ["2002:808:808::1", false],
    ["2002::", false],
    ["::ffff:0:a00:1", false],
    ["::ffff:0:7f00:1", false],
    ["::ffff:0:8.8.8.8", false],
    ["0:0:0:0:ffff:0:a00:1", false],
    ["::8.8.8.8", false],
    ["::808:808", false],
    ["2001::1", false],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", false],
    ["100::", false],
    ["100::1", false],
    ["2001:db8::1", false],
    ["2001:db8:ffff::1", false],
    ["2001:10::1", false],
    ["2001:1f::1", false],
    ["2001:20::1", false],
    ["2001:2f::1", false],
    ["2001:2::1", false],
    ["2001:2:0:ffff::1", false],
    ["1::1", false],
    ["4000::1", false],
    ["e000::1", false],
    // Not an address at all
    ["", false],
    ["localhost", false],
    ["1.2.3", false],
    ["1.2.3.256", false],
    ["01.2.3.4", false],
    ["::ffff:999.0.0.1", false],
    ["1::2::3", false],
    ["1:2:3:4:5:6:7:8:9", false],
    ["12345::1", false],
  ];
  it.each(CASES)("%s → public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("normaliseBaseUrl (what a provider's baseUrl is stored as)", () => {
  it("keeps scheme, host, port and path; drops a trailing slash, the query and the fragment", () => {
    expect(normaliseBaseUrl("https://api.example.com/v1", false)).toBe("https://api.example.com/v1");
    expect(normaliseBaseUrl("  https://API.Example.com:443/v1/?x=1#frag ", false)).toBe("https://api.example.com/v1");
    expect(normaliseBaseUrl("https://api.example.com:8443/v1//", false)).toBe("https://api.example.com:8443/v1");
    expect(normaliseBaseUrl("https://api.example.com", false)).toBe("https://api.example.com");
    expect(normaliseBaseUrl("https://api.example.com/", false)).toBe("https://api.example.com");
    expect(normaliseBaseUrl("https://10.0.0.5/v1", false)).toBe("https://10.0.0.5/v1"); // the address is checked when called
    expect(normaliseBaseUrl("https://[::1]:8080/v1", false)).toBe("https://[::1]:8080/v1");
    expect(normaliseBaseUrl("https://例え.jp/v1", false)).toBe("https://xn--r8jz45g.jp/v1");
  });

  it("refuses other schemes, credentials, hosts that are not plain DNS names and port 0", () => {
    for (const bad of [
      "http://api.example.com/v1",
      "ftp://api.example.com/",
      "file:///etc/passwd",
      "api.example.com/v1",
      "https://user:pass@api.example.com/v1",
      "https://user@api.example.com/v1",
      "https://@api.example.com/v1",
      "https://api.example.com@evil.example/v1",
      "https://exa_mple.com/v1",
      "https://a..b/v1",
      "https://-a.example/v1",
      "https://api.example.com:0/v1",
      "https://api.example.com:65536/v1",
      "https://:443/v1",
      "",
      "not a url",
    ]) {
      expect([bad, normaliseBaseUrl(bad, false)]).toEqual([bad, null]);
    }
  });

  it("accepts http: only with allowInsecureLocal (a build option for tests)", () => {
    expect(normaliseBaseUrl("http://127.0.0.1:9999/v1", false)).toBeNull();
    expect(normaliseBaseUrl("http://127.0.0.1:9999/v1/", true)).toBe("http://127.0.0.1:9999/v1");
  });
});

describe("guardedFetch refuses before connecting", () => {
  it("http:, without resolving the name", async () => {
    const resolve = scriptedResolver(["93.184.216.34"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 1000 });
    await expect(f("http://api.example.com/v1/models")).rejects.toMatchObject(refused);
    expect(resolve.calls).toEqual([]);
  });

  it("loopback, private, link-local, unspecified and IPv4-mapped addresses written in the URL", async () => {
    const v4 = await listener();
    const v6 = await listener(undefined, "::1");
    const resolve = scriptedResolver(["93.184.216.34"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 1000 });
    for (const url of [
      `https://127.0.0.1:${v4.port}/v1/models`,
      `https://[::1]:${v6.port}/v1/models`,
      "https://10.0.0.5/v1/models",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::ffff:10.0.0.1]/v1/models",
      `https://[::ffff:127.0.0.1]:${v4.port}/`,
      `https://2130706433:${v4.port}/`, // 127.0.0.1 as one number
      `https://0x7f.1:${v4.port}/`, // and in hex
      "https://0.0.0.0/",
      "https://[::]/",
      "https://[fe80::1]/",
      "https://[fd00::1]/",
      "https://100.64.0.1/",
    ]) {
      const error = await settle(f(url));
      expect([url, error]).toEqual([url, expect.objectContaining(refused)]);
      expect(error).toBeInstanceOf(AppError);
    }
    expect(v4.connections() + v6.connections()).toBe(0);
    expect(resolve.calls).toEqual([]); // a literal address is checked as it is
  });

  it("a name that resolves to a private address, or to one private address among public ones", async () => {
    const local = await listener();
    for (const answer of [["192.168.1.1"], ["93.184.216.34", "10.1.2.3"], ["2001:db8::1", "fd00::1"], ["127.0.0.1"], ["::ffff:192.168.0.1"]]) {
      const resolve = scriptedResolver(answer);
      const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 1000 });
      expect([answer, await settle(f(`https://intranet.example:${local.port}/v1/models`))]).toEqual([answer, expect.objectContaining(refused)]);
      expect(resolve.calls).toEqual(["intranet.example"]);
    }
    expect(local.connections()).toBe(0);
  });

  it("credentials in the URL, a host that is not a plain DNS name, a port outside 1–65535, and what is not a URL", async () => {
    const resolve = scriptedResolver(["93.184.216.34"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 1000 });
    for (const url of [
      "https://user:pass@api.example.com/v1",
      "https://user@api.example.com/v1",
      "https://@api.example.com/v1",
      "https://exa_mple.com/v1",
      "https://a..b/v1",
      "https://api.example.com:0/v1",
      "https://api.example.com:70000/v1",
      "ftp://api.example.com/",
      "not a url",
    ]) {
      expect([url, await settle(f(url))]).toEqual([url, expect.objectContaining(refused)]);
    }
    expect(resolve.calls).toEqual([]);
  });

  it("with allowInsecureLocal, loopback is allowed but private addresses still are not, and http: only to loopback", async () => {
    const f = (resolve: Resolve) => guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 1000, allowInsecureLocal: true });
    expect(await settle(f(scriptedResolver(["10.0.0.5"]))("https://intranet.example/v1"))).toMatchObject(refused);
    expect(await settle(f(scriptedResolver(["203.0.114.7"]))("http://public.example/v1"))).toMatchObject(refused);
    expect(await settle(f(scriptedResolver(["127.0.0.1", "203.0.114.7"]))("http://mixed.example/v1"))).toMatchObject(refused);
    expect(await settle(f(scriptedResolver([]))("http://10.0.0.5/v1"))).toMatchObject(refused);
  });
});

describe("guardedFetch connects to exactly the address it checked", () => {
  it("rebinding: one resolution per request, and the connection uses it — a name that turns local is refused", async () => {
    const local = await listener();
    // First request: the name resolves to a public (unrouted) address; if the guard looked the name
    // up again to connect, it would get 127.0.0.1 and reach the listener. It must dial the checked address instead
    // (which goes nowhere and times out). Second request: the name now resolves to 127.0.0.1 and is refused.
    const resolve = scriptedResolver(["203.0.114.7"], ["127.0.0.1"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 400 });
    const url = `https://rebind.example:${local.port}/v1/models`;
    expect(await settle(f(url))).toMatchObject(unavailable);
    expect(resolve.calls).toEqual(["rebind.example"]);
    expect(await settle(f(url))).toMatchObject(refused);
    expect(resolve.calls).toEqual(["rebind.example", "rebind.example"]);
    expect(local.connections()).toBe(0);
  });

  it("the checked address is dialled with the original host name as Host, and the resolver is asked once", async () => {
    const hosts: string[] = [];
    const local = await listener((req, res) => {
      hosts.push(req.headers.host ?? "");
      res.end("hello");
    });
    // A second lookup would answer an address nothing listens on.
    const resolve = scriptedResolver(["127.0.0.1"], ["203.0.114.7"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 2000, allowInsecureLocal: true });
    const res = await f(`http://pinned.example:${local.port}/v1/models`);
    expect([res.status, await res.text()]).toEqual([200, "hello"]);
    expect(res).toBeInstanceOf(Response);
    expect(resolve.calls).toEqual(["pinned.example"]);
    expect(hosts).toEqual([`pinned.example:${local.port}`]);
  });

  it("TLS is opened with the original host name as SNI", async () => {
    const names: string[] = [];
    const server = tls.createServer({
      SNICallback: (name, cb) => {
        names.push(name);
        cb(new Error("no certificate here"));
      },
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    open.push(server);
    const resolve = scriptedResolver(["127.0.0.1"]);
    const f = guardedFetch({ calls: room(), resolve, maxResponseBytes: 1000, timeoutMs: 2000, allowInsecureLocal: true });
    expect(await settle(f(`https://sni.example:${(server.address() as net.AddressInfo).port}/v1`))).toMatchObject(unavailable);
    expect(names).toEqual(["sni.example"]);
  });

  it("a name that does not resolve, or resolves to nothing, is provider_unavailable", async () => {
    const failing: Resolve = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await settle(guardedFetch({ calls: room(), resolve: failing, maxResponseBytes: 1000, timeoutMs: 1000 })("https://nowhere.example/"))).toMatchObject(unavailable);
    expect(await settle(guardedFetch({ calls: room(), resolve: scriptedResolver([]), maxResponseBytes: 1000, timeoutMs: 1000 })("https://empty.example/"))).toMatchObject(unavailable);
  });
});

describe("guardedFetch answers", () => {
  const f = guardedFetch({ calls: room(), maxResponseBytes: 1000, timeoutMs: 2000, allowInsecureLocal: true });

  it("does not follow redirects, whatever the caller asks: any 3xx is provider_unavailable", async () => {
    const target = await listener();
    for (const status of [301, 302, 303, 307, 308]) {
      const redirector = await listener((_req, res) => {
        res.writeHead(status, { location: `https://127.0.0.1:${target.port}/` });
        res.end("moved");
      });
      const url = `http://127.0.0.1:${redirector.port}/v1/models`;
      expect([status, await settle(f(url))]).toEqual([status, expect.objectContaining(unavailable)]);
      expect([status, await settle(f(url, { redirect: "follow" }))]).toEqual([status, expect.objectContaining(unavailable)]);
    }
    expect(target.connections()).toBe(0);
  });

  it("passes the request through: method, headers, body; returns status, headers and body", async () => {
    const seen: Array<{ method?: string; auth?: string; body: string }> = [];
    const echo = await listener((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method, auth: req.headers.authorization, body });
        res.writeHead(201, { "content-type": "application/json", "x-thing": "1" });
        res.end('{"ok":true}');
      });
    });
    const res = await f(`http://127.0.0.1:${echo.port}/v1/chat`, { method: "POST", headers: { authorization: "Bearer k" }, body: '{"a":1}' });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-thing")).toBe("1");
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ method: "POST", auth: "Bearer k", body: '{"a":1}' }]);
  });

  it("delivers exactly maxResponseBytes; one byte more aborts, with or without a Content-Length", async () => {
    const server = await listener((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const n = Number(url.searchParams.get("n"));
      if (!url.searchParams.has("chunked")) res.setHeader("content-length", n);
      res.write("a".repeat(Math.floor(n / 2)));
      res.end("a".repeat(n - Math.floor(n / 2)));
    });
    const read = async (query: string) => (await f(`http://127.0.0.1:${server.port}/?${query}`)).text();
    expect((await read("n=1000")).length).toBe(1000);
    expect((await read("n=1000&chunked")).length).toBe(1000);
    expect(await settle(read("n=1001"))).toMatchObject(unavailable);
    expect(await settle(read("n=1001&chunked"))).toMatchObject(unavailable);
    expect(await settle(read("n=50000&chunked"))).toMatchObject(unavailable);
  });

  it("a server that stalls aborts at timeoutMs: before the headers, and in the middle of the body", async () => {
    const quick = guardedFetch({ calls: room(), maxResponseBytes: 1000, timeoutMs: 300, allowInsecureLocal: true });
    const server = await listener((req, res) => {
      if (req.url === "/partial") {
        res.writeHead(200);
        res.write("part of it");
      }
      // "/silent": never answers.
    });
    let started = Date.now();
    expect(await settle(quick(`http://127.0.0.1:${server.port}/silent`))).toMatchObject(unavailable);
    let took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(3000);

    const res = await quick(`http://127.0.0.1:${server.port}/partial`);
    expect(res.status).toBe(200);
    started = Date.now();
    expect(await settle(res.text())).toMatchObject(unavailable);
    took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(200);
    expect(took).toBeLessThan(3000);
  });

  it("the outbound socket asks the system to probe a silent peer: TCP keepalive, first probe after 30 s idle", async () => {
    // What a unit test can prove: the knob is set on the socket the request goes out on. That the kernel then probes
    // and ends a dead connection is the system's doing (Linux: one probe 10 s later, libuv's fixed interval and count).
    expect(KEEPALIVE_IDLE_MS).toBe(30_000);
    const set = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    try {
      const server = await listener((_req, res) => void res.end("ok"));
      const f = guardedFetch({ calls: room(), maxResponseBytes: 1000, timeoutMs: 1000, allowInsecureLocal: true });
      expect(await (await f(`http://127.0.0.1:${server.port}/`)).text()).toBe("ok");
      expect(set.mock.calls).toContainEqual([true, KEEPALIVE_IDLE_MS]);
    } finally {
      set.mockRestore();
    }
  });

  it("connectTimeoutMs: a guard that waits long for an answer still gives up early on an address it cannot find", async () => {
    const hangs: Resolve = () => new Promise(() => {});
    const patient = guardedFetch({ calls: room(), maxResponseBytes: 1000, timeoutMs: 5_000, connectTimeoutMs: 300, allowInsecureLocal: true, resolve: hangs });
    let started = Date.now();
    expect(await settle(patient("https://models.example/v1"))).toMatchObject(unavailable);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(3000);

    // The address found, the wait for the answer is `timeoutMs`: headers that come after `connectTimeoutMs` are waited for.
    const server = await listener((_req, res) => void setTimeout(() => res.end("late but whole"), 700));
    started = Date.now();
    expect(await (await patient(`http://127.0.0.1:${server.port}/`)).text()).toBe("late but whole");
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
  });

  it("the time limit is between bytes: a slow but steady body is delivered", async () => {
    const quick = guardedFetch({ calls: room(), maxResponseBytes: 1000, timeoutMs: 300, allowInsecureLocal: true });
    const server = await listener((_req, res) => {
      res.writeHead(200);
      let i = 0;
      const tick = setInterval(() => {
        res.write(`${i}`);
        if (++i === 6) {
          clearInterval(tick);
          res.end();
        }
      }, 120);
    });
    const started = Date.now();
    expect(await (await quick(`http://127.0.0.1:${server.port}/`)).text()).toBe("012345");
    expect(Date.now() - started).toBeGreaterThan(300);
  });

  it("the caller's own abort passes through as an abort", async () => {
    const server = await listener(() => {}); // never answers
    const controller = new AbortController();
    const pending = settle(f(`http://127.0.0.1:${server.port}/`, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const error = (await pending) as Error;
    expect(error).not.toBeInstanceOf(AppError);
    expect(error.name).toBe("AbortError");
  });

  it("the caller's abort in the middle of the body closes the connection at once, read or not", async () => {
    let closed = false;
    const server = await listener((_req, res) => {
      res.writeHead(200);
      res.write("part of it");
      res.on("close", () => (closed = true));
    });
    const controller = new AbortController();
    const res = await f(`http://127.0.0.1:${server.port}/`, { signal: controller.signal });
    expect(res.status).toBe(200);
    controller.abort();
    const deadline = Date.now() + 1000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
  });
});

/** Reads a body chunk by chunk: what arrived, and the error that ended it (null when it ended normally). */
async function readAll(body: ReadableStream<Uint8Array>): Promise<{ text: string; error: unknown }> {
  const reader = body.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text, error: null };
      text += Buffer.from(value).toString("utf8");
    }
  } catch (error) {
    return { text, error };
  }
}

describe("guardedFetch: the time limit runs between bytes, from the headers on", () => {
  const T = 500;
  const quick = guardedFetch({ calls: room(), maxResponseBytes: 10_000, timeoutMs: T, allowInsecureLocal: true });

  /** Headers after `T/2`, then one chunk every `T/2` (`count` in all, then the end unless `stall`). */
  const steady = (count: number, stall = false) =>
    listener((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        let i = 0;
        const tick = setInterval(() => {
          res.write(`${i}`);
          if (++i === count) {
            clearInterval(tick);
            if (!stall) res.end();
          }
        }, T / 2);
        res.on("close", () => clearInterval(tick));
      }, T / 2);
    });

  it("is re-armed when the headers arrive: a long stream whose first byte comes T/2 after late headers is delivered", async () => {
    const server = await steady(6);
    const started = Date.now();
    const res = await quick(`http://127.0.0.1:${server.port}/`);
    expect(await readAll(res.body!)).toEqual({ text: "012345", error: null });
    expect(Date.now() - started).toBeGreaterThan(3 * T);
  });

  it("a long stream that stalls after some chunks is aborted about timeoutMs after its last byte", async () => {
    const server = await steady(4, true);
    const res = await quick(`http://127.0.0.1:${server.port}/`);
    const started = Date.now();
    const { text, error } = await readAll(res.body!);
    expect(text).toBe("0123");
    expect(error).toMatchObject(unavailable);
    expect(Date.now() - started).toBeGreaterThan(2 * T);
    expect(Date.now() - started).toBeLessThan(2 * T + 3000);
  });
});

describe("guardedFetch: provider calls in flight, site-wide", () => {
  /** A resolver whose answers wait until `open()`: a lookup in progress holds its call's slot. */
  function gatedResolver(address = "127.0.0.1") {
    const waiting: Array<() => void> = [];
    const resolve: Resolve = () =>
      new Promise((ok) => {
        waiting.push(() => ok([{ address, family: net.isIP(address) }]));
      });
    return {
      resolve,
      waiting,
      open: () => {
        for (const go of waiting.splice(0)) go();
      },
    };
  }
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };

  it("over the cap a call is provider_unavailable at once, without a lookup; ending a call gives its slot back", async () => {
    const calls = createSlots(2);
    const gate = gatedResolver();
    const server = await listener();
    const f = guardedFetch({ resolve: gate.resolve, calls, maxResponseBytes: 1000, timeoutMs: 2000, allowInsecureLocal: true });
    const url = `http://capped.example:${server.port}/`;
    const first = f(url);
    const second = f(url);
    await waitFor(() => gate.waiting.length === 2);
    expect(calls.inProgress()).toBe(2);

    // Refused, not queued behind the two held ones: a call that queued would be a third at the gate (asserted below, and a
    // refusal that came only at timeoutMs would too), so no elapsed-time bound is needed.
    expect(await settle(f(url))).toMatchObject(unavailable);
    expect(gate.waiting).toHaveLength(2); // the refused call looked nothing up

    gate.open();
    expect(await (await first).text()).toBe("ok");
    expect(await (await second).text()).toBe("ok");
    expect(calls.inProgress()).toBe(0);
    const third = f(url);
    await waitFor(() => gate.waiting.length === 1);
    gate.open();
    expect(await (await third).text()).toBe("ok");
    expect(server.connections()).toBe(3);
  });

  it("every way a call ends gives its slot back: refusal after the lookup, 3xx, stall, abort, a cancelled or broken body", async () => {
    const calls = createSlots(10);
    const server = await listener((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/" });
        res.end();
      } else if (req.url === "/stall") {
        res.writeHead(200);
        res.write("a");
      } else if (req.url === "/silent") {
        // never answers
      } else if (req.url === "/broken") {
        res.writeHead(200);
        res.write("a");
        setTimeout(() => res.socket?.destroy(), 20);
      } else {
        res.end("ok");
      }
    });
    const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    const f = guardedFetch({ calls, maxResponseBytes: 1000, timeoutMs: 300, allowInsecureLocal: true });

    const privateName = guardedFetch({ resolve: async () => [{ address: "10.0.0.5", family: 4 }], calls, maxResponseBytes: 1000, timeoutMs: 300 });
    expect(await settle(privateName("https://intranet.example/"))).toMatchObject(refused);
    expect(calls.inProgress()).toBe(0);

    expect(await settle(f(at("/redirect")))).toMatchObject(unavailable);
    expect(calls.inProgress()).toBe(0);

    expect(await settle(f(at("/silent")))).toMatchObject(unavailable);
    expect(calls.inProgress()).toBe(0);

    expect((await readAll((await f(at("/stall"))).body!)).error).toMatchObject(unavailable);
    expect(calls.inProgress()).toBe(0);

    expect((await readAll((await f(at("/broken"))).body!)).error).toMatchObject(unavailable);
    expect(calls.inProgress()).toBe(0);

    const controller = new AbortController();
    const aborted = settle(f(at("/silent"), { signal: controller.signal }));
    await waitFor(() => calls.inProgress() === 1);
    controller.abort();
    expect(((await aborted) as Error).name).toBe("AbortError");
    expect(calls.inProgress()).toBe(0);

    const cancelled = await f(at("/stall"));
    expect(calls.inProgress()).toBe(1);
    await cancelled.body!.cancel();
    expect(calls.inProgress()).toBe(0);

    await (await f(at("/"))).text();
    expect(calls.inProgress()).toBe(0);
  });

  it("guards given one count share it: at most its size of calls at once, across guards (the app gives every guard its one count)", async () => {
    const MAX = 16;
    const gate = gatedResolver();
    const server = await listener();
    const url = `http://shared.example:${server.port}/`;
    const options = { calls: createSlots(MAX), resolve: gate.resolve, maxResponseBytes: 1000, timeoutMs: 2000, allowInsecureLocal: true };
    const [a, b] = [guardedFetch(options), guardedFetch(options)];
    const pending = Array.from({ length: MAX }, (_, i) => (i % 2 === 0 ? a : b)(url));
    await waitFor(() => gate.waiting.length === MAX);
    expect(await settle(a(url))).toMatchObject(unavailable);
    expect(await settle(b(url))).toMatchObject(unavailable);
    gate.open();
    for (const p of pending) expect(await (await p).text()).toBe("ok");
    const again = a(url);
    await waitFor(() => gate.waiting.length === 1);
    gate.open();
    expect(await (await again).text()).toBe("ok");
  });
});
