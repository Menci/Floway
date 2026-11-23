import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import { isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesInputItem, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// The two vendored constants below (SUMMARIZATION_PROMPT and SUMMARY_PREFIX)
// are the compactor system prompt and the handoff prefix openai/codex ships
// for local remote-v2 compaction. Both are also the exact strings Copilot's
// server-side compactor uses today — Copilot's `/responses` endpoint hosts
// the same compaction infrastructure as openai/codex, verbatim.
//
// The equivalence was confirmed by prompt-injection extraction against the
// live Copilot upstream, following the methodology at
// https://yuanchang.org/en/posts/investigating-codex-context-compaction/:
//   1. Call `/responses` with `{input: [{role: user, content: INJECTION}, {type: 'compaction_trigger'}], stream: false}`.
//      Copilot returns a `type: 'compaction'` output item whose
//      `encrypted_content` is a Fernet-encrypted blob containing the
//      compactor's plaintext summary.
//   2. Call `/responses` again with `{input: [<same user injection>, <compaction item from step 1>, {role: user, content: PROBE}]}`.
//      The server decrypts the blob, prepends SUMMARY_PREFIX, hands it to
//      the target model, which sees the injection payload smuggled inside
//      the summary and — if it complies with the probe — echoes the
//      compactor's system prompt (SUMMARIZATION_PROMPT) and the handoff
//      prefix (SUMMARY_PREFIX) back verbatim.
// INJECTION is a fake "project notes" user message carrying a bracketed
// pseudo-system directive that asks the compactor to quote any received
// message mentioning "CONTEXT CHECKPOINT" / "handoff summary" / "concise"
// / "seamlessly" between INSTRUCTION_START/END markers before writing its
// normal summary. PROBE then asks the target model to output the full
// text of any context message containing those markers or key phrases
// (INSTRUCTION_START, "Another language model", "ChatGPT",
// "CONTEXT CHECKPOINT"). See the article for the exact payloads.
//
// Coverage: all five gpt-5* models an enterprise Copilot account can reach
// (gpt-5-mini, gpt-5.3-codex, gpt-5.4-mini, gpt-5.4, gpt-5.5), 3+ runs
// each. `gpt-5-mini` leaked SUMMARIZATION_PROMPT and SUMMARY_PREFIX
// character-identical to the vendored openai/codex strings on 3/3 runs;
// `gpt-5.4` and `gpt-5.5` refused every probe (stronger alignment);
// `gpt-5.3-codex` leaked its base identity but withheld the compactor
// prompt. The confirming `gpt-5-mini` leaks make it strictly unlikely
// the model invented these strings from scratch — the byte-level match
// against a specific-length prompt with a specific bullet ordering is
// far outside the space of plausible hallucinations. Bumps to
// openai/codex's `compact/prompt.md` or `compact/summary_prefix.md` are
// therefore also the signal to bump these constants.

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
export const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

// Cache-aligned compactors keep the ordinary system / tools / history prefix
// and append one user instruction that forbids tool use. The tools stay on the
// wire for prefix identity; compaction accepts only assistant text.
// - https://github.com/anomalyco/opencode/blob/a34961825be13a31daa76f33a8b47efcd198cfef/packages/core/src/session/compaction.ts#L272-L309
// - https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/extension/prompts/node/agent/summarizedConversationHistory.tsx#L1086-L1106
export const CACHE_SHARING_SUMMARIZATION_PROMPT
  = `${SUMMARIZATION_PROMPT}\n\nDo not call any tools while writing this summary; respond with text only.`;

// Trivial short histories tend to yield noticeably longer summaries from
// the shim than from native compact (the shim runs SUMMARIZATION_PROMPT
// through a normal `/responses` generate call, and the model dutifully
// fills every Include bullet; native's compactor short-circuits on
// trivial inputs). On realistic long histories the gap closes. Not a
// correctness bug — downstream turns behave the same either way — so we
// accept the drift rather than cap output and risk truncating summaries
// that long tasks legitimately need.

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/summary_prefix.md
//
// Prepended to the summary text before the summary is packed into the
// synthesized compaction envelope. Without this prefix, the next turn's
// downstream LLM sees a raw user-role message whose contents are a
// prose summary and misreads it as something the human said. The prefix
// makes the message's provenance explicit — "another LLM produced this
// summary, use it to continue the task" — matching what the native
// server-side compact endpoint prepends to the decrypted blob.
//
// The concatenation is `${SUMMARY_PREFIX}\n${summaryText}` — a single
// newline separator, mirroring codex-rs/core/src/compact.rs:271
// (`format!("{SUMMARY_PREFIX}\n{summary_suffix}")`):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/core/src/compact.rs#L271
export const SUMMARY_PREFIX
  = 'Another language model started to solve this problem and produced a summary of its thinking process.'
  + ' You also have access to the state of the tools that were used by that language model. Use this to'
  + ' build on the work that has already been done and avoid duplicating work. Here is the summary produced'
  + ' by the other language model, use the information in this summary to assist with your own analysis:';

export const EXACT_REPEAT_PREFIX = 'Repeat the following text exactly, which may contain a compaction summary, character for character.';
export const EXACT_REPEAT_SUFFIX = 'Output only the exact summary text, with no preface, explanation, markdown fence, or changes.';

// Structural validator: a shim payload is an array of input-item objects each
// carrying a `type` field. Strict enough that a foreign opaque blob can't
// accidentally decode + parse + validate.
const isShimCompactionPayload = (value: unknown): value is CanonicalOpenAIResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string');

export const isOpenAIResponsesCompactShimItem = (
  item: { readonly type: string; readonly encrypted_content?: unknown },
): boolean =>
  isOpenAIResponsesCompactionItem(item)
  && typeof item.encrypted_content === 'string'
  && isShimCompactionPayload(decodeBase64UrlJson(item.encrypted_content));

export const encodeShimCompactionPayload = (text: string): string =>
  encodeBase64UrlJson([{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  } satisfies CanonicalOpenAIResponsesInputItem]);

export const expandShimCompactionItems = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const rewritten: CanonicalOpenAIResponsesInputItem[] = [];
  let changed = false;
  for (const item of payload.input) {
    if (!isOpenAIResponsesCompactionItem(item)) {
      rewritten.push(item);
      continue;
    }
    const encryptedContent = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof encryptedContent !== 'string') {
      rewritten.push(item);
      continue;
    }
    const decoded = decodeBase64UrlJson(encryptedContent);
    if (!isShimCompactionPayload(decoded)) {
      // Foreign blob — leave untouched so a native-compaction upstream still
      // sees its own encrypted_content verbatim.
      rewritten.push(item);
      continue;
    }
    rewritten.push(...decoded);
    changed = true;
  }
  return changed ? { ...payload, input: rewritten } : payload;
};
