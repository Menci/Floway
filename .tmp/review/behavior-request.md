# Request-translation behaviour review — triage

Reviewer pinned to `277fbd600`; several items were already fixed by the time it
reported. Re-verified each against HEAD.

## Fixed after verification

- **C12 Responses narrowed a declaration list it can express** (`5da7cce21`).
  A `required` `allowed_tools` subset matching no declaration produced no tools
  and no choice — the caller demanded a call, the request said nothing may be
  called. The wire has the arm; it now passes declarations through.
- **C14 Messages dropped an explicitly empty assistant message** (`5da7cce21`).
  `content: ''` lost its turn, so two client turns merged across it.
- **C13 a `text` document source was labelled base64 without encoding**
  (`3e6e8f7ed`). The upstream would decode garbage. Now encoded, with a test.

## Already fixed by the time it reported

- C13's `content` arm throw (was already `TranslatorInputError`).
- The `writeStream` regression it may have seen mid-scan.

## Confirmed but needs a design decision — not changed

- **C11 legacy `function_call` result pairing.** A restored assistant turn that
  carries Chat's legacy `function_call` writes no id, while the client-side
  result carries the id the client's protocol generated. `legacyFunctionCallNamesOf`
  keys by the invented `legacy_call:<name>`, which can never equal that id, so
  the result falls back to a `tool` message naming an id no assistant turn
  states. The root cause is that the IR cannot distinguish a legacy call from a
  modern one — both normalise to `function_call`. Fixing it needs either an IR
  distinction or a decision that replay always writes the modern shape.
- **C15 `__`-qualified selectors.** `selectionToIR` splits only on the first
  `.`; main also bound `ns__name`. Restoring it needs the declaration context to
  tell a qualified name from a flat name containing `__`.
- **D16 the Chat ceiling is always `max_completion_tokens`.** main wrote
  `max_tokens`; many OpenAI-compatible upstreams reject the new name. Worth a
  deliberate decision and possibly a compatibility flag.

## Accepted as intended

- A1–A6, B7–B10, D17–D21 are the branch's documented fixes or the user's
  explicit requests.
