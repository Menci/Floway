import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesEasyInputMessageEx, CanonicalOpenAIResponsesInputItem, OpenAIResponsesRequestPayloadEx } from './index.ts';

// Expand shorthand input into explicitly discriminated message items.
export const canonicalizeOpenAIResponsesPayload = (value: unknown): CanonicalOpenAIResponsesPayload | {
  readonly error: { readonly message: string; readonly param?: string; readonly code?: string };
} => {
  const hasValidPromptCacheBreakpoint = (content: Record<string, unknown>): boolean => {
    const breakpoint = content.prompt_cache_breakpoint;
    if (breakpoint === undefined || breakpoint === null) return true;
    return typeof breakpoint === 'object'
      && typeof (breakpoint as Record<string, unknown>).mode === 'string';
  };

  const isImplicitEasyInputMessage = (item: unknown): item is OpenAIResponsesEasyInputMessageEx & { type?: undefined } => {
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
    return { error: { message: 'OpenAI Responses payload must be an object.' } };
  }
  const payload = value as OpenAIResponsesRequestPayloadEx;
  // https://github.com/mattermost/mattermost-plugin-agents/issues/476
  if (typeof payload.model !== 'string' || payload.model.length === 0) {
    return { error: { message: "Missing required parameter: 'model'.", param: 'model', code: 'missing_required_parameter' } };
  }
  const input: unknown = payload.input;
  if (typeof input !== 'string' && !Array.isArray(input)) {
    return { error: { message: 'OpenAI Responses input must be a string or an array.', param: 'input' } };
  }
  const canonical: CanonicalOpenAIResponsesPayload = { ...payload, model: payload.model, input: [] };
  const items = canonical.input;
  if (typeof input === 'string') {
    items.push({ type: 'message', role: 'user', content: input });
  } else {
    for (const [index, item] of input.entries()) {
      if (isImplicitEasyInputMessage(item)) {
        items.push({ ...item, type: 'message' });
      } else if (typeof item !== 'object' || item === null || (item as { type?: unknown }).type === undefined) {
        return { error: { message: 'Untyped OpenAI Responses input items require a valid role and content.', param: `input[${index}]` } };
      } else {
        items.push(item as CanonicalOpenAIResponsesInputItem);
      }
    }
  }
  return canonical;
};
