import { describe, expect, it } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { PNG } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";

// Scale 1: the avatar budget is 10 a minute per principal, the other group changes' 20.
const { blobs } = useProbeBlobs("af-group-avatar-rl-");
const { app, db } = useApp({ blobs, env: { RATE_LIMIT_SCALE: "1" } });

const putGroup = (who: Actor, conv: string) =>
  app.inject({ method: "PUT", url: `/api/conversations/${conv}/avatar`, headers: { cookie: who.cookie, "content-type": "image/png" }, payload: PNG });
const putMe = (who: Actor) =>
  app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie: who.cookie, "content-type": "image/png" }, payload: PNG });
const version = async (conv: string) =>
  (await db.query<{ avatar_version: number }>("select avatar_version from conversations where id = $1", [conv])).rows[0]!.avatar_version;

describe("the group avatar's budgets", () => {
  it("shares the 10 avatar uploads a minute with your own avatar (refused ones count), then 429 rate_limited; others are unaffected", async () => {
    const a = await signUp(app, "alice");
    const b = await signUp(app, "bobby");
    const c = await signUp(app, "carol");
    const g = await group(app, a, "team", [b, c]);
    for (let i = 0; i < 5; i++) expect((await putGroup(a, g)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await putMe(a)).statusCode).toBe(200);
    const refused = await app.inject({ method: "PUT", url: `/api/conversations/${g}/avatar`, headers: { cookie: a.cookie, "content-type": "image/png" }, payload: Buffer.from("<svg/>") });
    expect(refused.statusCode).toBe(400); // refused, still counted
    const over = await putGroup(a, g);
    expect(over.statusCode).toBe(429);
    expect(JSON.parse(over.body)).toEqual({ error: "rate_limited" });
    expect((await putMe(a)).statusCode).toBe(429);
    expect(await version(g)).toBe(5);
    expect((await putMe(c)).statusCode).toBe(200);
  });

  it("removing counts in the budget of the other group changes (20 a minute with renaming and members), not in the avatar budget", async () => {
    const a = await signUp(app, "erin");
    const b = await signUp(app, "frank");
    const c = await signUp(app, "gina");
    const g = await group(app, a, "team", [b, c]);
    for (let i = 0; i < 20; i++) expect((await api(app, a, "DELETE", `/api/conversations/${g}/avatar`)).status).toBe(200);
    expect(await api(app, a, "DELETE", `/api/conversations/${g}/avatar`)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await putMe(a)).statusCode).toBe(200);
  });
});
