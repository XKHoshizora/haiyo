import { describe, expect, it } from "vitest";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";

// Scale 1 (find-agent design, D6): the explicit step of a search (`exact=1`) is a lookup and counts in the lookup's own budget
// (30 a minute per principal, the same limiter); the suggestions typed along have a budget of their own, 120 a minute.
const { app } = useApp({ env: { RATE_LIMIT_SCALE: "1" }, config: SOCIAL_ON });

const lookup = (who: Actor, handle: string) => api(app, who, "GET", `/api/principals/lookup?handle=${handle}`);
const search = (who: Actor, q: string, exact = false) => api(app, who, "GET", `/api/principals/search?q=${q}${exact ? "&exact=1" : ""}`);
const LIMITED = { status: 429, json: { error: "rate_limited" } };

describe("search rate limits", () => {
  it("the exact step shares the lookup's 30 a minute; the suggestions are not counted there", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    for (let i = 1; i <= 15; i++) expect((await lookup(a, b.handle)).status).toBe(200);
    for (let i = 1; i <= 15; i++) expect((await search(a, i % 2 ? b.handle : `nobody_${i}`, true)).status).toBe(200);
    expect(await search(a, b.handle, true)).toEqual(LIMITED);
    expect(await lookup(a, b.handle)).toEqual(LIMITED);
    expect((await search(a, "bo")).status).toBe(200);
    expect((await search(b, a.handle, true)).status).toBe(200);
  });

  it("the suggestions have 120 a minute of their own; the lookup and the exact step are not counted there", async () => {
    const [a, b] = [await signUp(app, "carol"), await signUp(app, "dave")];
    for (let i = 1; i <= 120; i++) expect([i, (await search(a, i % 3 ? "da" : ""))]).toEqual([i, { status: 200, json: { circle: [] } }]);
    expect(await search(a, "da")).toEqual(LIMITED);
    expect((await lookup(a, b.handle)).status).toBe(200);
    expect((await search(a, b.handle, true)).status).toBe(200);
    expect((await search(b, "ca")).status).toBe(200);
  });

  it("the card by id counts in the suggestions' 120 (fix round 1, F8), found or not, malformed or not", async () => {
    const [a, b] = [await signUp(app, "erin"), await signUp(app, "frank")];
    const card = (who: Actor, id: string) => api(app, who, "GET", `/api/principals/agent-card/${id}`);
    for (let i = 1; i <= 60; i++) expect((await search(a, "fr")).status).toBe(200);
    for (let i = 1; i <= 60; i++) expect((await card(a, i % 2 ? "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d" : "abc")).status).toBe(404);
    expect(await card(a, "abc")).toEqual(LIMITED);
    expect(await search(a, "fr")).toEqual(LIMITED);
    expect((await search(a, b.handle, true)).status).toBe(200);
    expect((await card(b, "abc")).status).toBe(404);
  });
});
