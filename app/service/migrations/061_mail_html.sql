-- Up Migration
-- The HTML version of a mail (src/auth/mail-html.ts), sent next to the plain text (`body`) as Resend's `html`. Null for
-- every row queued before this: those are still sent, as text only.
alter table mail_outbox add column html text;

-- Down Migration
alter table mail_outbox drop column html;
