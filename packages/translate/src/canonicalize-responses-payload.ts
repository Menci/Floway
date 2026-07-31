import { TranslatorInputError } from './translator-input-error.ts';
import type { CanonicalResponsesPayload, ResponsesEasyInputMessage, ResponsesInputItem, ResponsesRequestPayload } from '@floway-dev/protocols/responses';

// Wire `ResponsesRequestPayload.input` accepts a bare string and EasyInputMessage
// objects whose `type: "message"` discriminator is omitted. The gateway's
// canonical internal shape is an explicitly discriminated item array: every
// consumer past HTTP / WS entry normalization or cross-protocol translation
// sees `type: "message"` on every message.
// Lifts a wire `ResponsesRequestPayload` to canonical form. Called at every wire
// boundary that produces a payload destined for internal use and by direct
// Responses-source translators; cross-protocol translators already construct
// `CanonicalResponsesPayload` with explicit message discriminators.
export function canonicalizeResponsesPayload(value: unknown): CanonicalResponsesPayload {
  const hasValidPromptCacheBreakpoint = (content: Record<string, unknown>): boolean => {
    const breakpoint = content.prompt_cache_breakpoint;
    if (breakpoint === undefined || breakpoint === null) return true;
    return typeof breakpoint === 'object'
      && typeof (breakpoint as Record<string, unknown>).mode === 'string';
  };

  const isImplicitEasyInputMessage = (item: unknown): item is ResponsesEasyInputMessage & { type?: undefined } => {
    if (typeof item !== 'object' || item === null) return false;
    const message = item as Record<string, unknown>;
    if (message.type !== undefined) return false;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system' && message.role !== 'developer') return false;
    if (message.phase !== undefined && message.phase !== null && typeof message.phase !== 'string') return false;
    return typeof message.content === 'string'
      || (Array.isArray(message.content) && message.content.every(part => {
        if (typeof part !== 'object' || part === null) return false;
        const content = part as Record<string, unknown>;
        switch (content.type) {
        case 'input_text':
        case 'output_text':
          return typeof content.text === 'string' && hasValidPromptCacheBreakpoint(content);
        case 'input_image':
          return (typeof content.image_url === 'string' || typeof content.file_id === 'string')
            && hasValidPromptCacheBreakpoint(content);
        case 'input_file':
          return hasValidPromptCacheBreakpoint(content);
        default:
          return false;
        }
      }));
  };

  if (typeof value !== 'object' || value === null) {
    throw new TranslatorInputError('Responses payload must be an object.');
  }
  const payload = value as ResponsesRequestPayload;
  // Resolution binds `model` straight into a SQL lookup, so the wire boundary is
  // the only place a missing id can still become a caller-facing 400; message
  // and code reproduce OpenAI's own rejection verbatim.
  // https://github.com/mattermost/mattermost-plugin-agents/issues/476
  if (typeof payload.model !== 'string' || payload.model.length === 0) {
    throw new TranslatorInputError("Missing required parameter: 'model'.", { param: 'model', code: 'missing_required_parameter' });
  }
  const input: unknown = payload.input;
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw new TranslatorInputError('Responses input must be a string or an array.', { param: 'input' });
  }
  return {
    ...payload,
    input: typeof input === 'string'
      ? [{ type: 'message', role: 'user', content: input }]
      : input.map((item, index) => {
          if (isImplicitEasyInputMessage(item)) return { ...item, type: 'message' };
          if (typeof item !== 'object' || item === null || (item as { type?: unknown }).type === undefined) {
            throw new TranslatorInputError('Untyped Responses input items require a valid role and content.', { param: `input[${index}]` });
          }
          return item as ResponsesInputItem;
        }),
  };
}
