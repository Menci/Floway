import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../../shared/base64url-json.ts';
import { isJsonObject } from '../../../../../shared/json-helpers.ts';
import { isOpenAIResponsesCompactionItem, type CanonicalOpenAIResponsesInputItem, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.';

// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/summary_prefix.md
export const SUMMARY_PREFIX
  = 'Another language model started to solve this problem and produced a summary of its thinking process.'
  + ' You also have access to the state of the tools that were used by that language model. Use this to'
  + ' build on the work that has already been done and avoid duplicating work. Here is the summary produced'
  + ' by the other language model, use the information in this summary to assist with your own analysis:';

const summaryMessage = (role: 'user' | 'system', text: string): CanonicalOpenAIResponsesInputItem =>
  ({ type: 'message', role, content: [{ type: 'input_text', text }] });

// The ordinary prompt prefix remains eligible for cache reuse. Keeping the
// tool inventory unchanged requires the appended instruction to forbid using it.
// https://github.com/anomalyco/opencode/blob/a34961825be13a31daa76f33a8b47efcd198cfef/packages/core/src/session/compaction.ts#L272-L309
export const summaryInput = (history: CanonicalOpenAIResponsesInputItem[]): CanonicalOpenAIResponsesInputItem[] => [
  ...history,
  summaryMessage('user', `${SUMMARIZATION_PROMPT}\n\nDo not call any tools while writing this summary; respond with text only.`),
];

export const summaryRetryInput = (history: CanonicalOpenAIResponsesInputItem[]): CanonicalOpenAIResponsesInputItem[] => [
  summaryMessage('system', SUMMARIZATION_PROMPT),
  ...history,
  summaryMessage('user', '<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>'),
];

const unpack = (item: { readonly type: string; readonly encrypted_content?: unknown }): CanonicalOpenAIResponsesInputItem[] | undefined => {
  if (!isOpenAIResponsesCompactionItem(item) || typeof item.encrypted_content !== 'string') return undefined;
  const value = decodeBase64UrlJson(item.encrypted_content);
  return Array.isArray(value) && value.every(item => isJsonObject(item) && typeof item.type === 'string') ? value : undefined;
};

export const isOpenAIResponsesCompactShimItem = (item: Parameters<typeof unpack>[0]): boolean => unpack(item) !== undefined;

export const packOpenAIResponsesCompactionText = (text: string): string =>
  encodeBase64UrlJson([summaryMessage('user', text)]);

export const expandOpenAIResponsesCompactionItems = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  let changed = false;
  const input = payload.input.flatMap(item => {
    const decoded = unpack(item as Parameters<typeof unpack>[0]);
    if (decoded === undefined) return [item];
    changed = true;
    return decoded;
  });
  return changed ? { ...payload, input } : payload;
};

type Usage = OpenAIResponsesResultEx['usage'];

export const sumOpenAIResponsesUsage = (left: Usage, right: Usage): NonNullable<Usage> | undefined => {
  if (left == null) return right ?? undefined;
  if (right == null) return left;
  const leftInput = left.input_tokens_details;
  const rightInput = right.input_tokens_details;
  const leftOutput = left.output_tokens_details;
  const rightOutput = right.output_tokens_details;
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    ...(leftInput !== undefined || rightInput !== undefined ? {
      input_tokens_details: {
        cached_tokens: (leftInput?.cached_tokens ?? 0) + (rightInput?.cached_tokens ?? 0),
        ...(leftInput?.cache_write_tokens !== undefined || rightInput?.cache_write_tokens !== undefined ? {
          cache_write_tokens: (leftInput?.cache_write_tokens ?? 0) + (rightInput?.cache_write_tokens ?? 0),
        } : {}),
      },
    } : {}),
    ...(leftOutput !== undefined || rightOutput !== undefined ? {
      output_tokens_details: {
        reasoning_tokens: (leftOutput?.reasoning_tokens ?? 0) + (rightOutput?.reasoning_tokens ?? 0),
      },
    } : {}),
  };
};
