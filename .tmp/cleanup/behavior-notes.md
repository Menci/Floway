# Behavior-diff decisions to report (not cleanup fixes)

## B1 — `maxChoices` removed (Chat target reading)
OLD: `createIRBuilder({ maxChoices: target.n ?? 1 })` rejected any choice index
>= the request's `n`.
NEW: `createIRBuilder()` admits choices by sequence only, rejecting a gap
(`index > choices.size`), not an index beyond `n`.
Effect: an upstream that reports more choices than the request asked for is now
rendered instead of rejected.
Provenance: deliberate commit `cb8002413`, whose comment says "the upstream's
own count is what decides how many there are, and a protocol that reports an
index out of order is malformed rather than merely large."
Classification: NEEDS-DISCUSSION (intentional design change, not covered by any
stated user instruction).

## B2 — Responses terminal snapshot no longer echoes `tools` / `tool_choice`
OLD: `restoreNamespaceEvents` rewrote `response.tools` / `response.tool_choice`
back to the client's original declarations whenever the upstream response
carried them.
NEW: `response()` emits neither field at all.
Effect: a Responses client no longer sees its own namespace declarations echoed
in `response.created` / `response.completed`.
Classification: NEEDS-DISCUSSION. The IR does not carry request declarations
forward into the returned stream, so restoring this would need a new path.
