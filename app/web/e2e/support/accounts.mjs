// Invites and the test inbox (the service's CLI locally; the E2E_INVITE_CMD / E2E_INBOX_CMD commands remotely),
// and accounts made through the API for specs that are not about signing up.
import { execFile, exec } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { REMOTE, SERVICE_DIR, cliEnv } from "./env.mjs";

const execFileP = promisify(execFile);
const execP = promisify(exec);

/** A suffix that keeps this run's names, handles and e-mails apart from every other run's. */
export const uniq = (n = 6) => randomBytes(8).toString("hex").slice(0, n);
/** A password nobody sees: random per account and per run, never written anywhere. */
export const newPassword = () => `pw-${randomBytes(18).toString("base64url")}`;
/** Generated e-mails only ever contain these characters, so they can go into a shell command as they are. */
const SAFE_EMAIL = /^[a-z0-9_.-]+@example\.test$/;

async function serviceCli(args) {
  const { stdout } = await execFileP(process.execPath, [path.join(SERVICE_DIR, "dist", "cli.js"), ...args], {
    cwd: os.tmpdir(), // the CLI reads a .env from its working directory: there is none here
    env: cliEnv(),
    windowsHide: true,
  });
  return stdout;
}

async function remoteCommand(template, email) {
  const command = email === undefined ? template : template.replaceAll("{email}", email);
  const { stdout } = await execP(command, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The operator gives `person` (by handle) `points` (a decimal string) through the service CLI; local suite only. */
export async function grantPoints(person, points) {
  if (REMOTE) throw new Error("granting points needs the local service CLI");
  if (!/^[a-z0-9_]{3,24}$/.test(person.handle) || !/^\d+(\.\d{1,6})?$/.test(points)) throw new Error("not a generated handle or a plain amount");
  await serviceCli(["credits:grant", "--handle", person.handle, "--points", points, "--note", "e2e"]);
}

/** A new single-use invite code. */
export async function mintInvite() {
  const out = REMOTE ? await remoteCommand(process.env.E2E_INVITE_CMD) : await serviceCli(["invite:create"]);
  const code = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /^[A-Za-z0-9_-]{20}$/.test(line));
  if (!code) throw new Error("the invite command printed no invite code");
  return code;
}

/** The mails to `email` as `inbox:list` prints them: [{kind, link}], oldest first. */
async function inbox(email) {
  if (!SAFE_EMAIL.test(email)) throw new Error("not a generated test e-mail");
  const out = REMOTE ? await remoteCommand(process.env.E2E_INBOX_CMD, email) : await serviceCli(["inbox:list", "--to", email]);
  const mails = [];
  for (const line of out.split(/\r?\n/)) {
    const head = /^#\d+ \S+ to=(\S+) kind=(\S+)\s*$/.exec(line);
    if (head) {
      mails.push({ to: head[1], kind: head[2], link: null });
      continue;
    }
    const link = /^\s+(https?:\/\/\S+)\s*$/.exec(line);
    const current = mails[mails.length - 1];
    if (link && current && current.link === null) current.link = link[1];
  }
  return mails.filter((m) => m.to === email);
}

/** The link of the newest mail of `kind` (`verify_email`, `reset_password`) to `email`, once it is there. */
export async function mailLink(email, kind) {
  let found = null;
  await expect
    .poll(
      async () => {
        const mails = (await inbox(email)).filter((m) => m.kind === kind);
        found = mails.length > 0 ? mails[mails.length - 1].link : null;
        return found;
      },
      { message: `a ${kind} mail to the test address`, timeout: 20_000, intervals: [200, 500, 1000] },
    )
    .toBeTruthy();
  return found;
}

/**
 * A new person's credentials: `label` makes the display name readable in failures, the suffix makes it unique.
 * `displayName` replaces the generated name (hostile names).
 */
export function newIdentity(label, { displayName } = {}) {
  const tag = uniq();
  const handle = `${label.toLowerCase().replace(/[^a-z0-9_]/g, "")}_${tag}`.slice(0, 24);
  return { label, handle, email: `${handle}@example.test`, password: newPassword(), displayName: displayName ?? `${label}${tag.slice(0, 4)}` };
}

const ok = async (res, what) => {
  if (!res.ok()) throw new Error(`${what}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
};

/** Registers through the API and opens the verification link: the account can sign in afterwards. */
export async function registerVerified(request, identity) {
  const inviteCode = await mintInvite();
  const { email, password, displayName, handle } = identity;
  await ok(await request.post("/api/register", { data: { inviteCode, email, password, displayName, handle } }), "register");
  const link = await mailLink(email, "verify_email");
  const res = await request.get(link, { maxRedirects: 0 });
  expect(res.status(), "the verification link redirects to the client").toBe(302);
  expect(res.headers().location).toMatch(/\/verify$/);
}

/** Signs `request` (a browser context's, so the page shares the cookie) in; returns the principal (`/api/me`). */
export async function signInApi(request, { email, password }) {
  await ok(await request.post("/api/auth/sign-in/email", { data: { email, password } }), "sign in");
  return ok(await request.get("/api/me"), "me");
}

/** `a` asks `b` (by handle), `b` accepts: they are friends and share a direct chat (its id is returned). */
export async function befriend(a, b) {
  const { id } = await ok(await a.request.post("/api/friend-requests", { data: { handle: b.handle } }), "friend request");
  const { conversationId } = await ok(await b.request.post(`/api/friend-requests/${id}/accept`), "accept");
  return conversationId;
}

/** A group of `creator` and `members` (friends of the creator), made through the API; returns its id. */
export async function createGroupApi(creator, members, title) {
  const { id } = await ok(
    await creator.request.post("/api/conversations", { data: { title, memberIds: members.map((m) => m.id) } }),
    "create group",
  );
  return id;
}

/** Sends a text message through the API (fast filler); returns the stored message. */
export async function sendApi(person, conversationId, text, mentions) {
  const { message } = await ok(
    await person.request.post(`/api/conversations/${conversationId}/messages`, { data: { clientTxn: randomUUID(), text, ...(mentions ? { mentions } : {}) } }),
    "send",
  );
  return message;
}
