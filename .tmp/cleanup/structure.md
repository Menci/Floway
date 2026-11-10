# Structure findings

## S1 composition.ts:169-215 — two entrypoints exist only for tests
`buildTargetRequestFor` and `translateSourceEventsFor` have no production
caller (grep over src/ excluding composition.ts is empty); they are used by 14
and 16 test files respectively. The skill lists "production structure created
only for tests" as a structure concern.

Counter-evidence for keeping them: they are not pass-throughs. Each re-states
the composed trip's exact half (`source.read` -> `settleTurns` -> `target.write`
for one; the same plus `target.readStream` + `source.writeStream` for the other),
and `buildTargetRequestFor` additionally accepts a pre-made `reading` so a test
can inspect what the reader recorded. Folding them back into `composeTranslation`
would force every request-shape test to drive a full event translation just to
assert the payload.

Verdict: NOT a cleanup fix. Removing them is a test-architecture decision that
would change ~30 test files, which is beyond "preserve observable behavior".
Recorded for the user as a judgment call, not applied.

## Findings reviewed and rejected (with reasons)

- **F6 `IRInputSettings.stream` is a dead flag.** Correct as an observation: every
  target writer returns the constant `true`. NOT applied, because the session's
  user instruction was explicitly "把 model 和 stream 也进了吧，少点旁路" — stream
  living in the IR is the requested design, and removing it would undo that.
- **F3 test-only composition entrypoints.** Real (14/16 test files, zero
  production callers), but removing them means rewriting ~30 test files' call
  shape. That is a test-architecture decision, not a behavior-preserving cleanup.
- **F8 `IRInputAddressed*` parallel type family.** The narrowing is what lets the
  three segmented writers read `call_id` without re-checking. Collapsing it
  lowers type safety at exactly the seam it protects.
- **F11 `select-tools` under `ir/input/`.** Defensible: both functions are pure
  policy over IR values with no wire shape. Moving them to `shared/` is a
  naming preference, not a defect.
- **Defensive #1/#25/#35**: reporting an unmatched tool result as
  `TranslatorInputError` (400 instead of 502) and refusing to forge an
  `octet-stream` MIME would each change observable behavior for inputs that
  currently succeed or produce a specific status. The cleanup contract forbids
  that; both are recorded as candidates for a separate change.
- **Defensive #2/#3/#31/#37/#50/#52 (unreachable)**: removing them tightens a
  contract at the cost of tolerance for foreign wire data. No current caller
  reaches them, but the guard costs one comparison and protects a path a future
  reader could take. Kept.
