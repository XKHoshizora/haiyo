import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

/** One request the fake APNs received. */
export interface ApnsRequest {
  path: string;
  headers: http2.IncomingHttpHeaders;
  /** The payload as sent (bytes as a string). */
  body: string;
  /** Which of the server's connections it came on (1, 2, …, in the order they opened). */
  connection: number;
}

/** How the fake answers one request: a status (and APNs reason), or a failure of the connection or the stream. */
export type ApnsAnswer = { status: number; reason?: string } | "reset" | "hang" | { hold: Promise<{ status: number; reason?: string }> };

export interface FakeApns {
  /** `http://127.0.0.1:<port>`: plain HTTP/2 (h2c), what a test's client is pointed at instead of Apple's. */
  url: string;
  requests: ApnsRequest[];
  /** Connections opened so far. */
  connections(): number;
  /** The next answers, in order; once used up, every request is answered 200. */
  answer(...answers: ApnsAnswer[]): void;
  /** Resolves once `n` requests have arrived (or rejects after `timeoutMs`). */
  waitFor(n: number, timeoutMs?: number): Promise<void>;
  reset(): void;
  close(): Promise<void>;
}

/**
 * A scripted stand-in for APNs (no network: a local HTTP/2 server on 127.0.0.1). It answers like APNs does: `:status`,
 * an `apns-id`, and for a failure a JSON body `{"reason": …}` (410 adds `timestamp`).
 */
export async function fakeApns(): Promise<FakeApns> {
  const requests: ApnsRequest[] = [];
  const script: ApnsAnswer[] = [];
  const waiters = new Set<() => void>();
  const open = new Set<http2.ServerHttp2Session>();
  let connections = 0;
  const server = http2.createServer();
  server.on("session", (session) => {
    open.add(session);
    session.on("close", () => open.delete(session));
    session.on("error", () => {});
    (session as unknown as { n: number }).n = ++connections;
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    stream.on("error", () => {});
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      requests.push({ path: String(headers[":path"]), headers, body: Buffer.concat(chunks).toString(), connection: (stream.session as unknown as { n: number }).n });
      for (const w of [...waiters]) w();
      const next = script.shift() ?? { status: 200 };
      const reply = (a: { status: number; reason?: string }) => {
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": a.status, "apns-id": randomUUID(), ...(a.status === 200 ? {} : { "content-type": "application/json" }) });
        stream.end(a.status === 200 ? undefined : JSON.stringify({ reason: a.reason ?? "Unknown", ...(a.status === 410 ? { timestamp: Date.now() } : {}) }));
      };
      if (next === "reset") stream.session?.destroy();
      else if (next === "hang") return;
      else if ("hold" in next) void next.hold.then(reply);
      else reply(next);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    connections: () => connections,
    answer: (...answers) => void script.push(...answers),
    waitFor(n, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (requests.length < n) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`fake APNs: ${requests.length} requests of ${n}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    reset() {
      requests.length = 0;
      script.length = 0;
      connections = 0;
    },
    async close() {
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
