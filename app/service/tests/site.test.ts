import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

/**
 * `GET /api/site` (README "Health", Site): what a page shown before sign-in needs of the site's setup — whether mail is
 * really delivered (`MAIL_MODE=resend`), so the page after registering and the forgot-password page say the truth. One
 * boolean, nothing else about the mail setup; the same for every caller, signed in or not.
 */
describe("site: mail not delivered (MAIL_MODE=outbox)", () => {
  const { app } = useApp();

  test("answers without a session: mailDelivered false, and nothing else", async () => {
    const r = await app.inject({ method: "GET", url: "/api/site" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mailDelivered: false });
  });
});

describe("site: mail delivered (MAIL_MODE=resend)", () => {
  const { app } = useApp({ env: { MAIL_MODE: "resend", RESEND_API_KEY: "re_test_key_that_must_never_be_printed", MAIL_FROM: "Haiyo <no-reply@mail.example>" } });

  test("mailDelivered true, and no word of the key, the sender or the provider", async () => {
    const r = await app.inject({ method: "GET", url: "/api/site" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mailDelivered: true });
    expect(r.body).not.toMatch(/re_test|mail\.example|resend/i);
  });
});
