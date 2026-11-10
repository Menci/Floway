# Concept leakage — main agent's verified findings

Rule: code that reads into or writes from the IR must not know the other side's
protocol. Only `protocols/composition.ts` names two protocols.

## Class 1 — hard leak (code)

1. **Gemini's source type carries Chat's audio format vocabulary.**
   `gemini-generate-content/as-source/input-to.ts:356-364`:
   ```
   // OpenAI Chat Completions accepts only WAV and MP3 input audio.
   const GEMINI_GENERATE_CONTENT_AUDIO_FORMATS = { 'audio/wav': 'wav', ... };
   ... | { kind: 'audio'; mimeType: ...; format: (typeof ...)[keyof ...]; data: string }
   ```
   `format: 'wav' | 'mp3'` is Chat's `input_audio.format`. Verified: **nothing
   reads `.format`**. Chat's target derives `wav`/`mp3` itself at
   `openai-chat-completions/as-target/input-from.ts:18-22` from the MIME type.
   So this is a dead field that exists only because a Gemini reader was written
   knowing what Chat needs.
   Fix: drop `format` and the table from the Gemini arm; keep `mimeType`.
   The `'unsupported'` discriminant also names a target's limit rather than
   describing the value; `'other'` is neutral.

2. **`IRInputSettings.continuous_usage` is written but never read, and Chat's
   writer bypasses the IR to get the same fact.**
   - Written: `openai-chat-completions/as-source/input-to.ts:311`
   - Read: nothing. No target reads it (correctly — it is the client's own
     rendering choice and must not go upstream), and Chat's source writer does
     not read it either.
   - The writer instead does `continuousUsageOf(payload)` at
     `openai-chat-completions/as-source.ts:27`, reading the raw request.
   Two problems in one: the IR field is dead, and the writer takes a bypass the
   user explicitly asked to remove ("把 model 和 stream 也进了吧，少点旁路").
   Fix: pass the IR setting into `writeStream`'s writer (it already receives
   `payload`; the right fix is for the writer to read the IR's
   `continuous_usage`). Requires deciding how a source writer sees its own
   read IR — see the note under class 3.

3. **`anthropic-messages/as-target/cache-breakpoints.ts:1-8` explains two other
   wires by name.**
   ```
   // Source APIs without an explicit cache_control concept — Codex on the OpenAI
   // Responses wire (opaque prompt_cache_key) and plain OpenAI Chat Completions
   // (no caching field) — silently drop the field through translation, so every
   // codex-through-anthropic-messages or chat-through-anthropic-messages turn
   // is a cache miss while native Anthropic Messages clients hit cache fine
   ```
   The behaviour (place breakpoints in the translated payload) is this
   protocol's own and is correct, but the prose teaches the reader about two
   other protocols and about specific pairings. Class 2 in code terms, class 1
   in spirit because it names pairs.

## Class 2 — comment-only leaks (verified, lower severity)

4. `gemini-generate-content/as-source/input-to.ts:356` — see finding 1; the
   comment goes with the dead table.
5. `openai-responses/as-source/allowed-tools.ts:4` — "Chat Completions and
   Anthropic Messages state a permitted subset by narrowing the declaration
   list". Explains why a Responses selector must resolve to a real declaration;
   the reasoning depends on two other wires.
6. `openai-chat-completions/as-target/sse-from.ts:427-431` — lists Messages,
   Responses and GenerateContent requirements to justify delaying a tool-name
   delta. Behaviour is Chat's own; the justification enumerates the other
   three.

## Class 3 — benign / reviewed, no action

- `ir/input/types.ts` protocol names in field comments (`// Responses`,
  `// ChatCompletions, GenerateContent`) are the field-applicability marks that
  make the IR readable. The IR is where protocols meet; marking which of them a
  field serves is its job.
- `shared/context-window-error.ts` cites OpenAI/Codex/Copilot message
  fragments. Recognizing those fragments is the function's purpose; the URLs
  are its evidence.
- `openai-responses/as-source.ts:25-38` reads `payload.tools` to echo the
  client's own declarations, because the IR holds a normalized form and the
  upstream states none of it. Documented and necessary.
- `openai-chat-completions/as-target/sse-from.ts:431` cites a Gemini streaming
  doc to explain why Chat cannot emit a nameless tool delta… (class 3 only if
  the cited fact constrains Chat; the reviewer will confirm).
