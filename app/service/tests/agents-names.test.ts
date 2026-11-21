import { afterEach, describe, expect, it } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Family names (Task N): an Agent's account name hangs under its owner's like a family name — `<owner's handle>.<name
 * part>`, e.g. `xiaolin.jarvis`. The owner chooses the name part (2–24 of `a-z0-9_`), unique among their Agents that are
 * not deleted; other owners may use the same one, and a person's handle never shares a pool with it. Everywhere an Agent's
 * handle is shown it is the full one, and so is every handle a model is told.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(() => expect(gateway.pending()).toBe(0));

const FAST = { source: "site", id: "fast" } as const;

const create = (owner: Actor, body: Record<string, unknown>) => api(app, owner, "POST", "/api/agents", { name: "贾维斯", ...body });

describe("creating an Agent with a name part", () => {
  it("its handle is the owner's handle, a dot and the name part; two owners may each have a jarvis", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    const mine = await create(xiaolin, { namePart: "jarvis" });
    const theirs = await create(bobby, { namePart: "jarvis" });
    expect([mine.status, mine.json.handle, theirs.status, theirs.json.handle]).toEqual([201, "xiaolin.jarvis", 201, "bobby.jarvis"]);
    expect((await api(app, xiaolin, "GET", `/api/agents/${mine.json.id}`)).json.handle).toBe("xiaolin.jarvis");
    expect((await api(app, xiaolin, "GET", "/api/agents")).json.agents.map((a: { handle: string }) => a.handle)).toEqual(["xiaolin.jarvis"]);
    // The principal everybody who sees it is sent carries the full handle too.
    const sync = (await api(app, xiaolin, "GET", "/api/sync")).json;
    expect(sync.principals.find((p: { id: string }) => p.id === mine.json.id)).toMatchObject({ kind: "agent", handle: "xiaolin.jarvis" });
  });

  it("the name part is 2 to 24 lower-case letters, digits or `_`; the key is `namePart`, and `handle` is no key", async () => {
    const owner = await signUp(app, "xiaolin");
    expect((await create(owner, { namePart: "ai" })).json.handle).toBe("xiaolin.ai");
    expect((await create(owner, { namePart: "b".repeat(24) })).status).toBe(201);
    for (const namePart of ["a", "b".repeat(25), "Jarvis", "jar-vis", "jar.vis", "贾维斯", "", " jarvis"]) {
      expect([namePart, (await create(owner, { namePart })).status]).toEqual([namePart, 400]);
    }
    expect((await create(owner, { handle: "jarvis" })).status).toBe(400);
    expect((await create(owner, { namePart: "jarvis2", handle: "jarvis2" })).status).toBe(400);
    expect((await create(owner, {})).status).toBe(400);
  });

  it("is unique among the owner's Agents that are not deleted: a second jarvis is 409 handle_taken, and free again at once when the first is deleted", async () => {
    const owner = await signUp(app, "xiaolin");
    const first = await create(owner, { namePart: "jarvis" });
    expect(await create(owner, { namePart: "jarvis" })).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await api(app, owner, "DELETE", `/api/agents/${first.json.id}`)).status).toBe(200);
    const again = await create(owner, { namePart: "jarvis" });
    expect([again.status, again.json.handle]).toEqual([201, "xiaolin.jarvis"]);
    expect(again.json.id).not.toBe(first.json.id);
    // The deleted one keeps the handle it had, shown as deleted; the new one is the only live jarvis.
    const listed = (await api(app, owner, "GET", "/api/agents")).json.agents.map((a: { id: string; handle: string; deleted: boolean }) => [a.id, a.handle, a.deleted]);
    expect(listed).toEqual([
      [first.json.id, "xiaolin.jarvis", true],
      [again.json.id, "xiaolin.jarvis", false],
    ]);
    expect(await create(owner, { namePart: "jarvis" })).toEqual({ status: 409, json: { error: "handle_taken" } });
  });

  it("a name part may be a person's handle, and a person may register a handle some Agent's name part is", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    expect((await create(xiaolin, { namePart: "bobby" })).json.handle).toBe("xiaolin.bobby");
    await create(bobby, { namePart: "carla" });
    // Registering `carla` is not refused for the Agent bobby.carla.
    const carla = await signUp(app, "carla");
    expect(carla.handle).toBe("carla");
  });

  it("the Agent limit is unchanged: a deleted Agent's name part is free at once, and a deleted Agent does not count", async () => {
    const owner = await signUp(app, "xiaolin");
    const made: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await create(owner, { namePart: `bot_${i}` });
      expect(res.status).toBe(201);
      made.push(res.json.id);
    }
    expect(await create(owner, { namePart: "one_more" })).toEqual({ status: 403, json: { error: "agent_limit" } });
    expect((await api(app, owner, "DELETE", `/api/agents/${made[0]}`)).status).toBe(200);
    // Its place and its name part are free: the same name part again is the 20th live Agent.
    expect((await create(owner, { namePart: "bot_0" })).json.handle).toBe("xiaolin.bot_0");
    expect(await create(owner, { namePart: "one_more" })).toEqual({ status: 403, json: { error: "agent_limit" } });
  });

  it("two creates of one name part at once by one owner: exactly one is made, the others are 409 handle_taken (fix round 1, M1)", async () => {
    const owner = await signUp(app, "xiaolin");
    const answers = await Promise.all([create(owner, { namePart: "jarvis" }), create(owner, { namePart: "jarvis" }), create(owner, { namePart: "jarvis" })]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409]);
    const live = await db.query("select 1 from principals p join agents a on a.principal_id = p.id where p.owner_id = $1 and p.handle = 'jarvis' and a.deleted_at is null", [owner.id]);
    expect(live.rowCount).toBe(1);
  });
});

describe("where an Agent's handle is shown, the full one", () => {
  it("to a fellow member: the member list, sync's principals, a message read's principals", async () => {
    const [xiaolin, bobby, carla] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "carla")];
    const g = await group(app, xiaolin, "family", [bobby, carla]);
    const agent = (await create(xiaolin, { namePart: "jarvis", model: FAST, persona: "简短。" })).json;
    expect((await api(app, xiaolin, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const members = (await api(app, bobby, "GET", `/api/conversations/${g}/members`)).json.members;
    expect(members.find((m: { id: string }) => m.id === agent.id)).toMatchObject({ kind: "agent", handle: "xiaolin.jarvis" });
    const sync = (await api(app, bobby, "GET", "/api/sync")).json;
    expect(sync.principals.find((p: { id: string }) => p.id === agent.id)).toMatchObject({ handle: "xiaolin.jarvis" });
    // Its appellation entry in its owner's view, too.
    const other = (await create(bobby, { namePart: "helper" })).json;
    expect((await api(app, bobby, "POST", `/api/conversations/${g}/members`, { principalId: other.id })).status).toBe(201);
    expect((await api(app, xiaolin, "PUT", `/api/agents/${agent.id}/appellations/${other.id}`, { appellation: "小帮手" })).status).toBe(200);
    const view = (await api(app, xiaolin, "GET", `/api/agents/${agent.id}`)).json;
    expect(view.appellations).toEqual([{ principalId: other.id, kind: "agent", handle: "bobby.helper", name: "贾维斯", appellation: "小帮手" }]);
  });

  it("to a model: the group's system text names the Agent, and the other Agents it may call, by their full handles", async () => {
    const [xiaolin, bobby, carla] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "carla")];
    const g = await group(app, xiaolin, "family", [bobby, carla]);
    const agent = (await create(xiaolin, { namePart: "jarvis", name: "贾维斯", model: FAST, persona: "简短。" })).json;
    const other = (await create(bobby, { namePart: "jarvis", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "简短。" })).json;
    for (const [who, id] of [[xiaolin, agent.id], [bobby, other.id]] as const) {
      expect((await api(app, who, "POST", `/api/conversations/${g}/members`, { principalId: id })).status).toBe(201);
    }
    expect((await api(app, bobby, "POST", `/api/conversations/${g}/messages`, { text: "@xiaolin.jarvis 你好", clientTxn: "n1" })).status).toBe(201);
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const system = gateway.calls.at(-1)!.system;
    expect(system).toContain("你是「贾维斯」（@xiaolin.jarvis），xiaolin 在 Haiyo 里的个人 Agent。");
    // Two jarvises here: only the full handle calls it, and that is all it is told.
    expect(system).toContain("有人在消息里写了 @xiaolin.jarvis 叫你，你才回复。");
    expect(system).toContain("- 阿杰（@bobby.jarvis）：擅长查资料");
    expect(system).not.toMatch(/@jarvis\b/);
  });

  it("to a model: where its name part alone calls it, it is told both ways it is called (fix round 1, M6)", async () => {
    const [xiaolin, bobby, carla] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "carla")];
    const g = await group(app, xiaolin, "family", [bobby, carla]);
    const agent = (await create(xiaolin, { namePart: "jarvis", name: "贾维斯", model: FAST, persona: "简短。" })).json;
    expect((await api(app, xiaolin, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    expect((await api(app, bobby, "POST", `/api/conversations/${g}/messages`, { text: "@jarvis 你好", clientTxn: "m6" })).status).toBe(201);
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.at(-1)!.system).toContain("有人在消息里写了 @xiaolin.jarvis（或 @jarvis）叫你，你才回复。");
  });

  it("a label whose name shows as nothing falls back to the full handle", async () => {
    const [xiaolin, bobby, carla] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "carla")];
    const g = await group(app, xiaolin, "family", [bobby, carla]);
    const agent = (await create(xiaolin, { namePart: "jarvis", name: "贾维斯", model: FAST, persona: "简短。" })).json;
    const quiet = (await create(bobby, { namePart: "quiet", name: "〔｜〕", model: FAST, persona: "简短。" })).json;
    for (const [who, id] of [[xiaolin, agent.id], [bobby, quiet.id]] as const) {
      expect((await api(app, who, "POST", `/api/conversations/${g}/members`, { principalId: id })).status).toBe(201);
    }
    await db.query("insert into messages (conversation_id, seq, sender_id, kind, body) select $1, seq + 1, $2, 'text', '{\"text\":\"我在\"}' from conversations where id = $1", [g, quiet.id]);
    await db.query("update conversations set seq = seq + 1 where id = $1", [g]);
    expect((await api(app, bobby, "POST", `/api/conversations/${g}/messages`, { text: "@xiaolin.jarvis 你好", clientTxn: "n2" })).status).toBe(201);
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    const texts = call.messages.flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")));
    expect(texts.some((t) => t.includes("bobby.quiet｜Agent〕"))).toBe(true);
  });
});
