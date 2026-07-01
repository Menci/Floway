// Per-request response header that names the alias the inbound id resolved
// through. Downstream observability ties together "client asked for X" /
// "upstream saw Y" via this header.
//
// Standalone so transport-level consumers (the alias-prelude in chat serves,
// the passthrough seam) can import it without dragging in the rule-overlay
// helpers from `apply-rules.ts`.
export const ALIAS_RESPONSE_HEADER = 'x-floway-alias';
