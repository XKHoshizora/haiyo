import { z } from "zod";
import type { Queryable } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * The versions of the terms of service and the privacy policy now in force. The texts are the web's
 * (`app/web/src/legal/texts/`); the web holds the same two strings (`app/web/src/legal/versions.js`, kept equal by
 * `app/web/tests/legal.test.jsx`). A text changed in a way people must agree to again gets a new version here and there:
 * every account is then asked again at its next sign-in (`termsAccepted`).
 */
export const LEGAL_VERSIONS = { terms: "2026-11-23.2", privacy: "2026-11-23.2" } as const;

/**
 * What a person sends when they accept (at registration, and in `POST /api/me/terms`): the two versions they were shown,
 * and that they declare they are 18 or older. Only `true` is a declaration; anything else is refused (400).
 */
export const acceptanceFields = {
  termsVersion: z.string().min(1).max(40),
  privacyVersion: z.string().min(1).max(40),
  adult: z.literal(true),
};

export interface Acceptance {
  termsVersion: string;
  privacyVersion: string;
}

/**
 * 409 `terms_outdated` unless the versions are the ones in force: a page shown before a new version came out asks for
 * a reload rather than have the service record a version the person did not read as the one they accepted.
 */
export function assertCurrentVersions(a: Acceptance): void {
  if (a.termsVersion !== LEGAL_VERSIONS.terms || a.privacyVersion !== LEGAL_VERSIONS.privacy) throw new AppError(409, "terms_outdated");
}

/**
 * Records that `principalId` accepted the versions in force and declared themselves 18 or older, now. Kept: an earlier
 * acceptance stays beside it (the history is the proof); accepting the same versions again changes nothing.
 */
export async function recordAcceptance(q: Queryable, principalId: string): Promise<void> {
  await q.query(
    `insert into terms_acceptances (principal_id, terms_version, privacy_version, adult_declared_at)
     values ($1, $2, $3, now()) on conflict do nothing`,
    [principalId, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy],
  );
}

/** Whether `principalId` has accepted the versions in force (false: they are asked at their next sign-in). */
export async function termsAccepted(q: Queryable, principalId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "select 1 from terms_acceptances where principal_id = $1 and terms_version = $2 and privacy_version = $3",
    [principalId, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy],
  );
  return rowCount === 1;
}
