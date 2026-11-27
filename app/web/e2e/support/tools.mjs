// What the tools specs (agents-tools.spec.mjs, whispers.spec.mjs) share: setup through the API (not what they are about),
// and a recorder of everything one person's browsers receive from the service.
import { expect } from "@playwright/test";
import { createGroupApi, uniq } from "./accounts.mjs";

/** The site's free model (system.mjs `siteModels`) as an Agent's model. */
export const FREE = { source: "site", id: "e2e-free" };

/** Chinese characters no other test writes: a search word that finds only what a test put there. */
const HAN = "春夏秋冬山水风云花月星河林海雪雨松竹梅兰江湖日光";
export const hanTag = (n = 4) => Array.from({ length: n }, () => HAN[Math.floor(Math.random() * HAN.length)]).join("");

/** An Agent of `owner`'s made through the API; resolves with the owner's view of it (`id`, `handle`, `name`…). */
/** The persona `agentApi` gives an Agent when none is named. */
export const DEFAULT_PERSONA = "你是一个乐于助人的助手。";

export async function agentApi(owner, { name, intro, persona = DEFAULT_PERSONA, model = FREE }) {
  const data = { namePart: `ag_${uniq(10)}`, name, model, persona };
  if (intro) data.intro = intro;
  const res = await owner.request.post("/api/agents", { data });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** A group of `creator` and `members` (the creator's friends), made through the API: `{id, title}`. */
export async function groupApi(creator, members, title = `群${uniq(6)}`) {
  return { id: await createGroupApi(creator, members, title), title };
}

/** `person` adds `principalId` (a friend, or their own Agent) to group `groupId` through the API. */
export async function addApi(person, groupId, principalId) {
  const res = await person.request.post(`/api/conversations/${groupId}/members`, { data: { principalId } });
  expect(res.status(), await res.text()).toBe(201);
}

/**
 * Everything `context`'s pages receive from now on: every HTTP response body and every WebSocket frame, as text.
 * `frames` is the list of frames so far; `all()` waits for the bodies still being read and joins bodies and frames;
 * `api()` is the bodies of the service's answers (`/api/…`), each `url\nbody`.
 */
export function recordTraffic(context) {
  const bodies = [];
  const frames = [];
  const reading = [];
  const watch = (page) => {
    page.on("response", (response) => {
      reading.push(
        response.body().then(
          (body) => bodies.push(`${response.url()}\n${body.toString("utf8")}`),
          () => {},
        ),
      );
    });
    page.on("websocket", (ws) => ws.on("framereceived", (frame) => frames.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"))));
  };
  context.on("page", watch);
  for (const page of context.pages()) watch(page);
  return {
    frames,
    async all() {
      await Promise.all(reading);
      return [...bodies, ...frames].join("\n");
    },
    async api() {
      await Promise.all(reading);
      return bodies.filter((b) => new URL(b.slice(0, b.indexOf("\n"))).pathname.startsWith("/api/"));
    },
  };
}

/**
 * A slow line for one page's WebSocket: every frame the service sends is passed on as it comes until one that `matches`
 * (a function of the frame's text) has been passed on; every frame after it is held back, in order, until `release()`.
 * What the page shows at that moment — a tool at work lasts a few milliseconds on the service — stays on screen as long as the
 * spec looks at it. Install it on the context (`context.routeWebSocket`) BEFORE the app is opened there (`people.openApp`).
 */
export async function slowLineAfter(context, matches) {
  let holding = false;
  let passed = false;
  let toPage = null;
  const held = [];
  await context.routeWebSocket(/\/api\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    toPage = ws;
    ws.onMessage((message) => server.send(message));
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
    server.onMessage((message) => {
      if (holding) {
        held.push(message);
        return;
      }
      ws.send(message);
      if (!passed && matches(typeof message === "string" ? message : message.toString("utf8"))) {
        passed = true;
        holding = true;
      }
    });
  });
  return {
    /** The frames held back are sent, in order, and the line is a normal one again. */
    release() {
      holding = false;
      for (const message of held.splice(0)) toPage.send(message);
    },
  };
}
