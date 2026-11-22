import React from "react";
import { TextLink } from "../ui/primitives.jsx";
import { LEGAL_DOCS, LEGAL_LINK_NAMES, LEGAL_PATHS } from "./docs.js";

/** A public page (the terms, the policy, the contact page) linked from a screen: in a new tab, so nothing typed is lost. */
export function LegalLink({ doc, children }) {
  return (
    <TextLink href={LEGAL_PATHS[doc]} target="_blank" rel="noopener">
      {children ?? LEGAL_LINK_NAMES[doc]}
    </TextLink>
  );
}

/** The three public pages, in a row under an account screen. */
export function LegalLinks() {
  return (
    <nav className="auth-legal" aria-label="条款与联系">
      {LEGAL_DOCS.map((doc) => (
        <LegalLink key={doc} doc={doc} />
      ))}
    </nav>
  );
}
