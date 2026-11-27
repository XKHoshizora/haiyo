import http from "node:http";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createJudge, JudgeError, type Question } from "../src/judge/client.ts";
import { scriptedJudge } from "./helpers/judge.ts";

const n = (p: number) => ({ type: "noul" as const, p });

/** One request a stub received. */
interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Handler = (req: Seen, res: http.ServerResponse) => void;

let servers: http.Server[] = [];
const sockets = new Set<net.Socket>();

/** A local HTTP stub; `handler` answers every request. */
async function stub(handler: Handler): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(entry, res);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    seen,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

const answering =
  (answers: unknown): Handler =>
  (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers }));
  };

const KEY_A = "secret-key-aaaa";
const KEY_B = "secret-key-bbbb";
const env = { JUDGE_KEY_A: KEY_A, JUDGE_KEY_B: KEY_B };

const make = (urls: string[], extra: { timeoutMs?: number } = {}) =>
  createJudge(
    {
      model: "jev-1",
      channels: urls.map((url, i) => ({ url, apiKeyEnv: i === 0 ? "JUDGE_KEY_A" : "JUDGE_KEY_B" })),
      timeoutMs: extra.timeoutMs ?? 4000,
      dailyLimit: 20000,
    },
    { allowInsecureLocal: true, env },
  );

const Q: Question[] = [
  { key: "need", type: "noul", instructions: "它应该现在回复吗" },
  { key: "addr", type: "noul", instructions: "这条消息是在对它说话吗" },
];

beforeEach(() => {
  servers = [];
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

const WHO: Question = { key: "who", type: "choice", instructions: "谁应该回答", options: { a1: "小明，懂天气", a2: "小红，懂菜谱" } };

describe("the judgement client, choice questions", () => {
  test("a mixed call sends criteria for a choice and parses its probabilities", async () => {
    const a = await stub(
      answering({
        need: { noul: 0.4 },
        who: { type: "choice", choice: "a1", confidence: 0.9, probabilities: { a1: 0.7, a2: 0.3 } },
      }),
    );
    const got = await make([a.url]).ask("状态", [Q[0]!, WHO]);
    expect(JSON.parse(a.seen[0]!.body).questions).toEqual({
      need: { type: "noul", instructions: "它应该现在回复吗" },
      who: { type: "choice", instructions: "谁应该回答", criteria: { a1: "小明，懂天气", a2: "小红，懂菜谱" } },
    });
    expect(got).toEqual(
      new Map<string, unknown>([
        ["need", n(0.4)],
        ["who", { type: "choice", probabilities: new Map([["a1", 0.7], ["a2", 0.3]]) }],
      ]),
    );
  });

  test("unknown options, out-of-range and missing ones are dropped; no probabilities or no survivor: key absent", async () => {
    const a = await stub(
      answering({
        who: { type: "choice", probabilities: { a1: 1.2, a2: 0.4, zz: 0.5, a3: "x" } },
        w2: { type: "choice", probabilities: { a1: -1, zz: 0.5 } },
        w3: { type: "choice", choice: "a1", confidence: 1 },
        w4: { type: "choice", probabilities: [0.5] },
      }),
    );
    const opts = { a1: "x", a2: "y", a3: "z" };
    const qs: Question[] = [WHO, ...["w2", "w3", "w4"].map((key): Question => ({ key, type: "choice", instructions: key, options: opts }))];
    qs[0] = { ...WHO, options: opts };
    const got = await make([a.url]).ask("s", qs);
    expect(got).toEqual(new Map<string, unknown>([["who", { type: "choice", probabilities: new Map([["a2", 0.4]]) }]]));
  });

  test("a choice with no options, an empty option key or more than 254 options is not sent; only invalid: no request", async () => {
    const a = await stub(answering({ need: { noul: 0.5 } }));
    const many = Object.fromEntries(Array.from({ length: 255 }, (_, i) => ["o" + i, "d"]));
    const bad: Question[] = [
      { key: "e0", type: "choice", instructions: "i", options: {} },
      { key: "e1", type: "choice", instructions: "i", options: { "": "d" } },
      { key: "e2", type: "choice", instructions: "i", options: many },
    ];
    expect(await make([a.url]).ask("s", bad)).toEqual(new Map());
    expect(a.seen).toHaveLength(0);
    expect(await make([a.url]).ask("s", [...bad, Q[0]!])).toEqual(new Map([["need", n(0.5)]]));
    expect(Object.keys(JSON.parse(a.seen[0]!.body).questions)).toEqual(["need"]);
  });
});

describe("the judgement client", () => {
  test("sends the exact request: POST, both headers, body shape, the model, UTF-8 intact", async () => {
    const a = await stub(answering({ need: { noul: 0.7 }, addr: { noul: 0.2 } }));
    const got = await make([a.url]).ask("小明：你好，今天天气怎么样？", Q);
    expect(a.seen).toHaveLength(1);
    const req = a.seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/systemone");
    expect(req.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(req.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(req.body)).toEqual({
      model: "jev-1",
      state: "小明：你好，今天天气怎么样？",
      questions: {
        need: { type: "noul", instructions: "它应该现在回复吗" },
        addr: { type: "noul", instructions: "这条消息是在对它说话吗" },
      },
    });
    expect(got).toEqual(
      new Map([
        ["need", n(0.7)],
        ["addr", n(0.2)],
      ]),
    );
  });

  test("answers outside [0, 1], non-numbers and missing keys are left out; extra keys ignored; 0 and 1 kept", async () => {
    const a = await stub(
      answering({
        low: { noul: -0.1 },
        high: { noul: 1.2 },
        str: { noul: "0.5" },
        nul: { noul: null },
        bare: 0.5,
        zero: { noul: 0 },
        one: { noul: 1 },
        extra: { noul: 0.4 },
      }),
    );
    const qs = ["low", "high", "str", "nul", "bare", "zero", "one", "gone"].map((key): Question => ({ key, type: "noul", instructions: key }));
    const got = await make([a.url]).ask("s", qs);
    expect(got).toEqual(
      new Map([
        ["zero", n(0)],
        ["one", n(1)],
      ]),
    );
  });

  test("a second channel is used after a 500, after invalid JSON, after a wrong shape and after a timeout", async () => {
    const good = await stub(answering({ need: { noul: 0.9 } }));
    const failures: Handler[] = [
      (_r, res) => {
        res.writeHead(500);
        res.end("boom");
      },
      (_r, res) => {
        res.writeHead(200);
        res.end("not json {");
      },
      (_r, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({ nothing: true }));
      },
      () => {}, // never answers
    ];
    for (const handler of failures) {
      const bad = await stub(handler);
      const got = await make([bad.url, good.url], { timeoutMs: 500 }).ask("s", [Q[0]!]);
      expect(got).toEqual(new Map([["need", n(0.9)]]));
      expect(bad.seen).toHaveLength(1);
    }
    expect(good.seen[0]!.headers.authorization).toBe(`Bearer ${KEY_B}`);
  });

  test("both channels failing throws a JudgeError that names no key and no path", async () => {
    const bad = (code: number) =>
      stub((_r, res) => {
        res.writeHead(code);
        res.end(`upstream said ${KEY_A}`);
      });
    const one = await bad(500);
    const two = await bad(503);
    const err = await make([one.url, two.url]).ask("私密的状态", Q).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JudgeError);
    const message = (err as Error).message;
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(KEY_B);
    expect(message).not.toContain("/v1/systemone");
    expect(message).not.toContain("私密的状态");
    expect(message).not.toContain("它应该现在回复吗");
    expect(one.seen).toHaveLength(1);
    expect(two.seen).toHaveLength(1);
  });

  test("an unreachable channel is a failure like any other", async () => {
    const good = await stub(answering({ need: { noul: 0.5 } }));
    const dead = await stub(() => {});
    await dead.close();
    expect(await make([dead.url, good.url], { timeoutMs: 1000 }).ask("s", [Q[0]!])).toEqual(new Map([["need", n(0.5)]]));
  });

  test("the caller's signal aborting rejects promptly with its reason, not a JudgeError, without trying the next channel", async () => {
    const hang = await stub(() => {});
    const next = await stub(answering({ need: { noul: 0.5 } }));
    const ctl = new AbortController();
    const why = new Error("the caller gave up");
    const started = Date.now();
    const pending = make([hang.url, next.url], { timeoutMs: 30_000 }).ask("s", [Q[0]!], ctl.signal);
    setTimeout(() => ctl.abort(why), 100);
    await expect(pending).rejects.toBe(why);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(next.seen).toHaveLength(0);
  });

  test("an already aborted signal makes no request, and rejects with its reason", async () => {
    const a = await stub(answering({ need: { noul: 0.5 } }));
    const ctl = new AbortController();
    const why = new Error("aborted before");
    ctl.abort(why);
    await expect(make([a.url]).ask("s", [Q[0]!], ctl.signal)).rejects.toBe(why);
    expect(a.seen).toHaveLength(0);
  });

  test("no questions: an empty map and no request", async () => {
    const a = await stub(answering({}));
    expect(await make([a.url]).ask("s", [])).toEqual(new Map());
    expect(a.seen).toHaveLength(0);
  });

  test("a key variable unset at call time is a failure of that channel", async () => {
    const a = await stub(answering({ need: { noul: 0.5 } }));
    const judge = createJudge(
      { model: "m", channels: [{ url: a.url, apiKeyEnv: "NOT_SET_ANYWHERE" }], timeoutMs: 1000, dailyLimit: 10 },
      { allowInsecureLocal: true, env: {} },
    );
    await expect(judge.ask("s", [Q[0]!])).rejects.toBeInstanceOf(JudgeError);
    expect(a.seen).toHaveLength(0);
  });

  test("an answer larger than the cap is a failure, its length declared or not (streamed)", async () => {
    const body = JSON.stringify({ answers: { need: { noul: 0.5 } }, pad: "x".repeat(200_000) });
    const declared = await stub((_r, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const streamed = await stub((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // No content-length: chunked, each piece well under the cap, together over it.
      for (let i = 0; i < body.length; i += 8192) res.write(body.slice(i, i + 8192));
      res.end();
    });
    for (const url of [declared.url, streamed.url]) {
      const err = await make([url]).ask("s", [Q[0]!]).then(() => null, (e: unknown) => e);
      expect([url, err instanceof JudgeError && err.reason]).toEqual([url, "oversize"]);
    }
  });

  test("a question key is sent as given, even __proto__, and a key asked twice is sent once", async () => {
    const a = await stub(answering({ ["__proto__"]: { noul: 0.3 }, need: { noul: 0.6 } }));
    const proto: Question = { key: "__proto__", type: "noul", instructions: "原型" };
    const got = await make([a.url]).ask("s", [proto, Q[0]!, { ...Q[0]!, instructions: "又问一次" }]);
    expect(Object.keys(JSON.parse(a.seen[0]!.body).questions)).toEqual(["__proto__", "need"]);
    expect(JSON.parse(a.seen[0]!.body).questions.need.instructions).toBe("它应该现在回复吗");
    expect(got).toEqual(
      new Map([
        ["__proto__", n(0.3)],
        ["need", n(0.6)],
      ]),
    );
  });
});

describe("why no channel answered (JudgeError.reason), coarse and text-free", () => {
  const failing = (status: number) =>
    stub((_r, res) => {
      res.writeHead(status);
      res.end("no");
    });

  const reasonOf = async (urls: string[], extra: { timeoutMs?: number } = {}, env?: Record<string, string>) => {
    const judge = env
      ? createJudge({ model: "m", channels: urls.map((url) => ({ url, apiKeyEnv: "JUDGE_KEY_A" })), timeoutMs: extra.timeoutMs ?? 4000, dailyLimit: 10 }, { allowInsecureLocal: true, env })
      : make(urls, extra);
    const err = await judge.ask("s", [Q[0]!]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeError);
    return (err as JudgeError).reason;
  };

  test("401 and 403 are auth; any other status is status", async () => {
    expect(await reasonOf([(await failing(401)).url])).toBe("auth");
    expect(await reasonOf([(await failing(403)).url])).toBe("auth");
    expect(await reasonOf([(await failing(500)).url])).toBe("status");
    expect(await reasonOf([(await failing(204)).url])).toBe("status");
  });

  test("an answer that is not JSON, or not { answers }, is shape", async () => {
    for (const text of ["not json {", JSON.stringify({ nothing: true })]) {
      const bad = await stub((_r, res) => {
        res.writeHead(200);
        res.end(text);
      });
      expect(await reasonOf([bad.url])).toBe("shape");
    }
  });

  test("no answer in time is timeout; a key variable not set is key_unset; nobody listening is network", async () => {
    expect(await reasonOf([(await stub(() => {})).url], { timeoutMs: 500 })).toBe("timeout");
    expect(await reasonOf([(await failing(500)).url], {}, {})).toBe("key_unset");
    const dead = await stub(() => {});
    await dead.close();
    expect(await reasonOf([dead.url], { timeoutMs: 1000 })).toBe("network");
  });

  test("no place among the judgement's calls in flight is busy, and nothing is sent; a place freed is used again", async () => {
    // The first 32 requests are never answered; any later one is.
    const answer = answering({ need: { noul: 0.5 } });
    const server = await stub((req, res) => (server.seen.indexOf(req) < 32 ? undefined : answer(req, res)));
    const judge = make([server.url], { timeoutMs: 30_000 });
    const ctl = new AbortController();
    // The client's own cap on calls in flight (MAX_CALLS, 32): every place held by a call that is not answered.
    const held = Array.from({ length: 32 }, () => judge.ask("s", [Q[0]!], ctl.signal).catch(() => null));
    const deadline = Date.now() + 5000;
    while (server.seen.length < 32 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(server.seen).toHaveLength(32);
    const err = await judge.ask("s", [Q[0]!]).then(() => null, (e: unknown) => e);
    expect([err instanceof JudgeError, (err as JudgeError).reason]).toEqual([true, "busy"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.seen).toHaveLength(32);
    ctl.abort();
    await Promise.all(held);
    expect(await judge.ask("s", [Q[0]!])).toEqual(new Map([["need", n(0.5)]]));
  });

  test("the reason is the last channel's", async () => {
    const [unauthorised, broken] = [await failing(401), await failing(500)];
    expect(await reasonOf([unauthorised.url, broken.url])).toBe("status");
    expect(await reasonOf([broken.url, unauthorised.url])).toBe("auth");
  });

  test("its message names none of it", async () => {
    const err = await make([(await failing(401)).url]).ask("s", [Q[0]!]).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("the judgement model gave no answer");
  });
});

describe("the scripted judgement model (tests/helpers/judge.ts)", () => {
  test("like the client, it records no call when nothing it is asked could be sent", async () => {
    const judge = scriptedJudge();
    expect(await judge.ask("s", [])).toEqual(new Map());
    expect(await judge.ask("s", [{ key: "pick", type: "choice", instructions: "i", options: {} }])).toEqual(new Map());
    expect(judge.calls).toEqual([]);
    await judge.ask("s", [Q[0]!]);
    expect(judge.calls).toHaveLength(1);
  });
});
