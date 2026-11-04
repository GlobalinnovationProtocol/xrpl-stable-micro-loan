export const TERMS_VERSION = "2026-10-21";

export const TERMS_TEXT = `DISCLAIMER AND TERMS

The disclaimer and terms for this program will be announced by the legal team.

Accept to continue to the program's KYC step.`;

export const ACCEPT_PHRASE = "I ACCEPT";

export function termsAccepted(body) {
  const a = body?.acceptedTerms;
  return Boolean(a) && a.version === TERMS_VERSION && a.lender === true && a.borrower === true;
}
