// A stand-in for the iOS shell's bridge (the shell's README, "Bridge"): `window.webkit.messageHandlers.haiyo.postMessage({ name, args })`
// returns a promise; each reply is scripted. `emit` sends an event the way the shell does (`haiyo:<name>` on window).
import { vi } from "vitest";

export const HELLO = { bridge: 1, shell: "0.1.0", build: "7", os: "26.1", push: "granted", events: ["pause", "resume", "open"], layout: null };

/**
 * @param {object} [o]
 * @param {object|Function} [o.hello] the reply of `hello` (a function gets the args)
 * @param {object|Function} [o.register] the reply of `push.register`
 * @param {object|Function} [o.badge] the reply of `badge.set`
 */
export function installShell({ hello = HELLO, register = { token: "ab".repeat(32), env: "development" }, badge = { ok: true } } = {}) {
  const calls = [];
  const replies = { hello, "push.register": register, "badge.set": badge };
  const handler = {
    postMessage: vi.fn((message) => {
      calls.push(JSON.parse(JSON.stringify(message)));
      const reply = replies[message.name];
      if (reply === undefined) return Promise.reject(new Error("unknown"));
      const value = typeof reply === "function" ? reply(message.args) : reply;
      return value instanceof Promise ? value : Promise.resolve(value);
    }),
  };
  window.webkit = { messageHandlers: { haiyo: handler } };
  return {
    calls,
    handler,
    replies,
    named: (name) => calls.filter((c) => c.name === name),
    emit: (name, detail) => window.dispatchEvent(new CustomEvent(`haiyo:${name}`, { detail })),
    remove: () => {
      delete window.webkit;
    },
  };
}

/** The API the page calls for push (api/routes.js), recording the order of every call among `order`. */
export function fakePushApi(order = [], over = {}) {
  return {
    registerPushDevice: vi.fn(async (body) => {
      order.push("POST");
      return { ok: true, ...over.postResult, body };
    }),
    removePushDevice: vi.fn(async () => {
      order.push("DELETE");
      return { ok: true };
    }),
    ...over,
  };
}
