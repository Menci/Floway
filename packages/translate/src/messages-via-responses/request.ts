import { openAiJsonSchemaCoreFromMessagesFormat } from '../shared/messages/structured-output.ts';
import { messagesReasoningBlockToResponsesReasoning } from '../shared/messages-and-responses/reasoning.ts';
import { resolveMessagesReasoningEffort } from '../shared/messages-via/reasoning-effort.ts';
import { normalizeMessagesToolInputSchema } from '../shared/messages-via/tool-schema.ts';
import { type CanonicalResponsesPayload } from '../shared/via-responses/responses-items.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import {
  type MessagesAssistantMessage,
  type MessagesClientTool,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesServerToolUseBlock,
  type MessagesSystemMessage,
  type MessagesTextBlock,
  type MessagesToolResultBlock,
  type MessagesToolUseBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
  type MessagesWebSearchToolResultBlock,
} from '@floway-dev/protocols/messages';
import type { ResponsesInputContent, ResponsesInputItem, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

const flushPendingContent = (pending: ResponsesInputContent[], input: ResponsesInputItem[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const translateUserContentBlock = (
  block: Exclude<MessagesUserContentBlock, MessagesToolResultBlock>,
  messageIdx: number,
  blockIdx: number,
): ResponsesInputContent => {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'image') {
    return {
      type: 'input_image',
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      detail: 'auto',
    };
  }

  throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' user content blocks are not supported on this model`);
};

const toResponsesToolResultOutput = (content: MessagesToolResultBlock['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  const textBlocks = content.filter((block): block is MessagesTextBlock => block.type === 'text');
  if (textBlocks.length === content.length) {
    return textBlocks.map(block => block.text).join('\n\n');
  }

  return JSON.stringify(content);
};

const toResponsesFunctionCall = (block: MessagesToolUseBlock | MessagesServerToolUseBlock): ResponsesInputItem => ({
  type: 'function_call',
  call_id: block.id,
  name: block.name,
  arguments: JSON.stringify(block.input),
  status: 'completed',
});

const toResponsesStructuredToolOutput = (block: MessagesWebSearchToolResultBlock): Extract<ResponsesInputItem, { type: 'function_call_output' }> => ({
  type: 'function_call_output',
  call_id: block.tool_use_id,
  output: JSON.stringify(block.content),
  status: Array.isArray(block.content) ? 'completed' : 'incomplete',
});

const getClientTools = (tools?: MessagesPayload['tools']): MessagesClientTool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  const clientTools = tools.filter((tool): tool is MessagesClientTool => tool.type === undefined || tool.type === 'custom');
  return clientTools.length > 0 ? clientTools : undefined;
};

const translateUserMessage = (message: MessagesUserMessage, messageIdx: number): ResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content }];
  }

  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_result') {
      // Responses can represent alternating user content and tool outputs, so
      // preserve Messages block chronology instead of moving all tool results to
      // the front of the turn.
      flushPendingContent(pendingContent, input, 'user');
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: toResponsesToolResultOutput(block.content),
        status: block.is_error ? 'incomplete' : 'completed',
      });
      continue;
    }

    pendingContent.push(translateUserContentBlock(block, messageIdx, blockIdx));
  }

  flushPendingContent(pendingContent, input, 'user');
  return input;
};

const translateAssistantMessage = (message: MessagesAssistantMessage, messageIdx: number): ResponsesInputItem[] => {
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'assistant', content: message.content }];
  }

  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toResponsesFunctionCall(block));
      continue;
    }

    if (block.type === 'web_search_tool_result') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(toResponsesStructuredToolOutput(block));
      continue;
    }

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flushPendingContent(pendingContent, input, 'assistant');
      input.push(messagesReasoningBlockToResponsesReasoning(block, input.length));
      continue;
    }

    if (block.type === 'text') {
      pendingContent.push({ type: 'output_text', text: block.text });
      continue;
    }

    throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
  }

  flushPendingContent(pendingContent, input, 'assistant');
  return input;
};

// Preserve per-block boundaries when the source carries a
// MessagesTextBlock[]; single-string source stays as string content.
const translateMessagesSystem = (message: MessagesSystemMessage): ResponsesInputItem[] => [
  {
    type: 'message',
    role: 'system',
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map(block => ({ type: 'input_text', text: block.text })),
  },
];

const translateMessagesInput = (messages: MessagesMessage[]): ResponsesInputItem[] =>
  messages.flatMap((message, messageIdx): ResponsesInputItem[] => {
    switch (message.role) {
    case 'user': return translateUserMessage(message, messageIdx);
    case 'assistant': return translateAssistantMessage(message, messageIdx);
    case 'system': return translateMessagesSystem(message);
    default: throw new TranslatorInputError(`messages.${messageIdx}.role: role '${(message as { role: string }).role}' is not supported on this model`);
    }
  });

// Responses' `instructions` field is `string | null` — it cannot carry
// multiple text blocks faithfully. When the source `MessagesPayload.system`
// is a single string or a single block, the canonical `instructions` slot
// is the right home. When the source is a multi-block array, the canonical
// slot would silently merge the boundaries, so emit a leading input
// system message with multi-part `input_text` content instead and leave
// `instructions` null; both placements act as a system prompt prefix at
// the upstream and the multi-part form preserves the caller-visible block
// structure.
interface SystemPlacement {
  readonly instructions: string | null;
  readonly prependItems: readonly ResponsesInputItem[];
}

const placeMessagesSystem = (system: string | MessagesTextBlock[] | undefined): SystemPlacement => {
  if (typeof system === 'string') return { instructions: system, prependItems: [] };
  if (!system || system.length === 0) return { instructions: null, prependItems: [] };
  if (system.length === 1) return { instructions: system[0].text, prependItems: [] };
  return {
    instructions: null,
    prependItems: [{
      type: 'message',
      role: 'system',
      content: system.map(block => ({ type: 'input_text', text: block.text })),
    }],
  };
};

const translateTools = (tools: MessagesClientTool[] | undefined): ResponsesTool[] | null => {
  if (!tools || tools.length === 0) return null;

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    parameters: normalizeMessagesToolInputSchema(tool.input_schema),
    // Responses tools default stricter than Anthropic/Chat-style function tools,
    // so omitted source strictness is made explicit as false.
    strict: tool.strict ?? false,
    ...(tool.description ? { description: tool.description } : {}),
  }));
};

const translateToolChoice = (toolChoice: MessagesPayload['tool_choice'], tools?: MessagesClientTool[]): ResponsesToolChoice => {
  if (!toolChoice || !tools || tools.length === 0) return 'auto';

  const toolNames = new Set(tools.map(tool => tool.name));

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool':
    return toolChoice.name && toolNames.has(toolChoice.name) ? { type: 'function', name: toolChoice.name } : 'auto';
  case 'none':
    return 'none';
  default:
    return 'auto';
  }
};

export const translateMessagesToResponses = (payload: MessagesPayload): CanonicalResponsesPayload => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = resolveMessagesReasoningEffort(payload);
  const reasoning = effort ? { effort } : undefined;
  const clientTools = getClientTools(payload.tools);
  const { instructions, prependItems } = placeMessagesSystem(payload.system);
  const jsonSchema = openAiJsonSchemaCoreFromMessagesFormat(payload.output_config?.format);
  const text = jsonSchema ? { format: { type: 'json_schema' as const, ...jsonSchema } } : undefined;

  // `speed: 'fast'` maps to Responses `service_tier: 'fast'`; other non-fast
  // `speed` values have no OpenAI equivalent and are dropped. When `speed` is
  // absent, Anthropic's own `service_tier` ('auto'/'standard_only') is passed
  // through verbatim for symmetry with the forward direction.
  const serviceTier = payload.speed === 'fast' ? 'fast' : payload.speed === undefined ? payload.service_tier : undefined;

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, or `reasoning.summary` when the
  // Messages source did not express those knobs.
  return {
    model: payload.model,
    input: [...prependItems, ...translateMessagesInput(payload.messages)],
    ...(instructions !== null ? { instructions } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    max_output_tokens: payload.max_tokens,
    ...(payload.tools !== undefined ? { tools: translateTools(clientTools) } : {}),
    tool_choice: translateToolChoice(payload.tool_choice, clientTools),
    ...(payload.metadata ? { metadata: { ...payload.metadata } } : {}),
    stream: true,
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};

export { translateMessagesToResponses as buildTargetRequest };
