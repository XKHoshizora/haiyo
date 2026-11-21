import { describe, expect, test } from "vitest";
import {
  RESET_PASSWORD_TTL_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
  registrationAttemptMail,
  resetPasswordMail,
  verifyEmailMail,
} from "../src/auth/mail-copy.ts";
import { api, mailLink, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const IGNORE = "如果这不是你本人的操作，请忽略这封邮件。";
const NOT_REGISTERED = "如果你没有注册 Haiyo，请不要点击链接，直接忽略这封邮件。";

describe("mail copy", () => {
  test("the verification mail is plain Simplified Chinese: link on its own line, validity, do-not-click line", () => {
    const url = "http://localhost:5173/api/auth/verify-email?token=abc&callbackURL=http%3A%2F%2Flocalhost%3A5173%2Fverify";
    const m = verifyEmailMail(url);
    expect(m.subject).toBe("验证你的 Haiyo 邮箱");
    const lines = m.body.split("\n");
    expect(lines).toContain(url);
    expect(m.body).toContain("Haiyo");
    expect(m.body).toContain("24 小时");
    // Someone else may have registered this address: the reader is told not to confirm what they did not start.
    expect(lines.at(-1)).toBe(NOT_REGISTERED);
    expect(m.body).not.toMatch(/Verify|Confirm/);
  });

  test("the registration-attempt notice says nothing changed, links sign-in and reset, and ends with the ignore line", () => {
    const m = registrationAttemptMail("http://localhost:5173/signin", "http://localhost:5173/forgot");
    expect(m.subject).toBe("有人尝试用你的邮箱注册 Haiyo");
    const lines = m.body.split("\n");
    expect(lines).toEqual(expect.arrayContaining(["http://localhost:5173/signin", "http://localhost:5173/forgot"]));
    expect(m.body).toContain("没有创建新账号");
    expect(lines.at(-1)).toBe(IGNORE);
  });

  test("the reset mail says how long the link is valid", () => {
    const link = "http://localhost:5173/reset-password?token=t%2F1";
    const m = resetPasswordMail(link);
    expect(m.subject).toBe("重置你的 Haiyo 密码");
    expect(m.body.split("\n")).toContain(link);
    expect(m.body).toContain("1 小时");
    expect(m.body.split("\n").at(-1)).toBe(IGNORE);
  });

  test("the stated lifetimes are the configured ones (24 hours, 1 hour)", () => {
    expect([VERIFY_EMAIL_TTL_SECONDS, RESET_PASSWORD_TTL_SECONDS]).toEqual([86400, 3600]);
  });

  describe("as stored in the outbox", () => {
    const { app, db } = useApp();
    test("registration and reset write the Chinese mails", async () => {
      const a = await signUp(app, "copy_user");
      await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      const rows = (await db.query<{ kind: string; subject: string; body: string; html: string | null }>("select kind, subject, body, html from mail_outbox order by id")).rows;
      const verify = rows.find((r) => r.kind === "verify_email")!;
      const reset = rows.find((r) => r.kind === "reset_password")!;
      expect(verify.subject).toBe("验证你的 Haiyo 邮箱");
      expect(reset.subject).toBe("重置你的 Haiyo 密码");
      expect(verify.html).toContain("验证你的邮箱");
      expect(reset.html).toContain("重置你的密码");
      expect(verify.body).toContain(NOT_REGISTERED);
      expect(reset.body).toContain(IGNORE);
      expect(await mailLink(app, a.email, "reset_password")).toMatch(/^\/reset-password\?token=/);
    });
  });
});
