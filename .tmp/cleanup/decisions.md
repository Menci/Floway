# Behaviour decisions settled by the user

Recorded so a later review does not raise them again as open questions.

## Accepted as-is (do not re-raise)

- **D1 choice count** — the output IR admits choices by sequence; an upstream
  reporting more choices than the request asked for is rendered rather than
  rejected. Accepted.
- **D3 remote images** — a Messages target forwards an image URL instead of
  fetching and inlining it, and accepts `input_file` / `document`. Accepted.
- **D4 Responses HTTP error body** — restated as the SSE event shape
  `{type, message, code, param}` rather than the HTTP envelope. Accepted.
- **D6 single system message** — a one-part prompt run is folded to a string.
  Accepted.
- **D7 reasoning quantities** — `summary` and `content` are concatenated into
  one `reasoning_text`. Accepted.
- **D8 unmodelled inlineData MIME** — forwarded as a Chat `file` instead of
  rejected. Accepted.
- **D9 metadata forwarding** — Messages-source metadata reaches a Chat target.
  Accepted.
- **D10 reasoning-drop warning** — silent; no `console.warn`. Accepted.
- **D11 same-name namespace function+custom** — flat names are merged with a
  collision suffix instead of rejected as ambiguous. Accepted.

## Fixed

- **D2** — response objects echo the client's declarations again
  (`06d4a8c9e`).
- **D5** — Messages tool declarations state `type: 'custom'` again
  (`06d4a8c9e`).

## C class, fixed earlier

`a09f2c795`: non-first system `content: []`, `null` arguments,
budget-vs-level precedence, orphan `tool_choice` on a Responses target,
`search_result` JSON array, unified text joins.
`06d4a8c9e`: C#10 legacy pairing (plan 3).

Unresolved-anything: none.
