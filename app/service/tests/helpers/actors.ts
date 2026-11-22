import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createInvite } from "../../src/auth/invites.ts";
import { LEGAL_VERSIONS } from "../../src/legal.ts";

/** What every registration carries: the documents in force accepted, 18+ declared (src/legal.ts). */
export const TERMS = { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy, adult: true } as const;

export interface Actor {
  id: string;
  handle: string;
  email: string;
  password: string;
  /** Value for the `cookie` request header. */
  cookie: string;
}

export interface ApiResult<T = any> {
  status: number;
  json: T;
}

/** Calls the app in-process. `actor` (or null) supplies the session cookie. */
export async function api<T = any>(
  app: FastifyInstance,
  actor: { cookie: string } | null,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await app.inject({
    method,
    url,
    headers: actor ? { cookie: actor.cookie } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  const text = res.body;
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.statusCode, json: json as T };
}

/** Pulls `name=value` of every cookie a response set, joined for a `cookie` header. */
export function cookieHeaderFrom(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

/** The first URL in the newest mail of `kind` to `email`, as a path+query on this app. */
export async function mailLink(app: FastifyInstance, email: string, kind: string): Promise<string> {
  const { rows } = await app.deps.db.query<{ body: string }>(
    "select body from mail_outbox where recipient = $1 and kind = $2 order by id desc limit 1",
    [email, kind],
  );
  const body = rows[0]?.body;
  if (!body) throw new Error(`no ${kind} mail for ${email}`);
  const url = new URL(/https?:\/\/\S+/.exec(body)![0]);
  return url.pathname + url.search;
}

export async function signIn(app: FastifyInstance, email: string, password: string) {
  return app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: { email, password } });
}

/** Registers (with a fresh invite), verifies the e-mail, signs in; returns the actor. */
export async function signUp(app: FastifyInstance, name: string): Promise<Actor> {
  const handle = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24).padEnd(3, "_");
  const email = `${handle}@example.test`;
  const password = `pw-${randomBytes(9).toString("hex")}`;

  const inviteCode = await createInvite(app.deps.db, { ttlHours: 1 });
  const reg = await api(app, null, "POST", "/api/register", { inviteCode, email, password, displayName: name, handle, ...TERMS });
  if (reg.status !== 201) throw new Error(`signUp: register failed ${reg.status} ${JSON.stringify(reg.json)}`);

  const verify = await app.inject({ method: "GET", url: await mailLink(app, email, "verify_email") });
  if (verify.statusCode >= 400) throw new Error(`signUp: verify failed ${verify.statusCode} ${verify.body}`);

  const res = await signIn(app, email, password);
  if (res.statusCode !== 200) throw new Error(`signUp: sign-in failed ${res.statusCode} ${res.body}`);
  const cookie = cookieHeaderFrom(res.headers["set-cookie"]);

  const me = await api<{ id: string }>(app, { cookie }, "GET", "/api/me");
  if (me.status !== 200) throw new Error(`signUp: /api/me failed ${me.status}`);
  return { id: me.json.id, handle, email, password, cookie };
}

/** `a` sends `b` a friend request and `b` accepts it; returns the direct conversation's id. */
export async function befriend(app: FastifyInstance, a: Actor, b: Actor): Promise<{ conversationId: string }> {
  const sent = await api<{ id: string }>(app, a, "POST", "/api/friend-requests", { handle: b.handle });
  if (sent.status !== 201) throw new Error(`befriend: request failed ${sent.status} ${JSON.stringify(sent.json)}`);
  const accepted = await api<{ conversationId: string }>(app, b, "POST", `/api/friend-requests/${sent.json.id}/accept`);
  if (accepted.status !== 200) throw new Error(`befriend: accept failed ${accepted.status} ${JSON.stringify(accepted.json)}`);
  return { conversationId: accepted.json.conversationId };
}

let seated = 0;

/**
 * A person who never signs in, seated in group `conv` straight in the database as if they had joined at `joinedSeq`:
 * for a group larger than signing everyone up is worth. Returns their id.
 */
export async function seatPerson(app: FastifyInstance, conv: string, name: string, joinedSeq: number): Promise<string> {
  const { rows } = await app.deps.db.query<{ id: string }>(
    `with u as (insert into "user" (id, name, email, "emailVerified") values ($3, $2, $3 || '@example.test', true) returning id)
     insert into principals (kind, handle, display_name, auth_user_id) select 'human', $1, $2, id from u returning id`,
    [`seated_${++seated}`, name, `seated-${randomBytes(8).toString("hex")}`],
  );
  const id = rows[0]!.id;
  await app.deps.db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', $3)", [conv, id, joinedSeq]);
  return id;
}

/** `creator` makes a group with `members`, befriending any that are not yet friends; returns its id. */
export async function group(app: FastifyInstance, creator: Actor, title: string, members: Actor[]): Promise<string> {
  const social = await api<{ friends: { id: string }[] }>(app, creator, "GET", "/api/social");
  const friends = new Set(social.json.friends.map((f) => f.id));
  for (const m of members) if (!friends.has(m.id)) await befriend(app, creator, m);
  const created = await api<{ id: string }>(app, creator, "POST", "/api/conversations", {
    title,
    memberIds: members.map((m) => m.id),
  });
  if (created.status !== 201) throw new Error(`group: create failed ${created.status} ${JSON.stringify(created.json)}`);
  return created.json.id;
}
