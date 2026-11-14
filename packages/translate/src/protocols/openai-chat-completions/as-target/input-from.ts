import type { IRInputAssistantItemWithCallIds, IRInputTurnWithCallIds, IRInputClientItemWithCallIds } from '../../../composition/request/call-ids.ts';
import { requireStreaming } from '../../../ir/input/streaming.ts';
import type { IRInputRequestHeader, IRInputSettings, IRInputTool, IRInputToolChoice, IRInputDocument, IRInputMedia, IRInputToolResultContentPart, IRInputClientItem } from '../../../ir/input/types.ts';
import { buildCustomToolInputSchema } from '../../../shared/custom-tool.ts';
import { DOCUMENT_CLOSE_TAG, documentImage, documentOpening } from '../../../shared/document.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { reasoningEffortForBudget } from '../../../shared/reasoning-budget.ts';
import type {
  OpenAIChatCompletionsPayload,
  OpenAIChatCompletionsMessage,
  OpenAIChatCompletionsStreamOptionsEx,
  OpenAIChatCompletionsToolCall,
  OpenAIChatCompletionsTool,
  OpenAIChatCompletionsUserContentPart,
} from '@floway-dev/protocols/openai-chat-completions';

// Chat Completions names a container while the input IR keeps MIME types.
const audioFormat = (mediaType: string): string => {
  if (mediaType === 'audio/wav') return 'wav';
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return 'mp3';
  throw new TranslateInputException(`Cannot translate audio MIME type '${mediaType}' to OpenAI Chat Completions.`);
};

const dataUrl = (media: Extract<IRInputMedia, { source_kind: 'base64' }>, requireMediaType: boolean): string => media.media_type === undefined && !requireMediaType
  ? media.data
  : `data:${media.media_type ?? 'application/octet-stream'};base64,${media.data}`;

const imageUrlPart = (media: IRInputMedia, detail?: string | null): OpenAIChatCompletionsUserContentPart => ({
  type: 'image_url',
  image_url: {
    url: media.source_kind === 'url' ? media.url
      : media.source_kind === 'data' ? media.data.startsWith('data:') ? media.data : `data:application/octet-stream;base64,${media.data}`
        : media.source_kind === 'base64' ? dataUrl(media, true)
          : (() => { throw new TranslateInputException('Cannot translate file_id-only image content to OpenAI Chat Completions.'); })(),
    ...(detail == null ? {} : { detail }),
  },
});

const filePart = (media: IRInputMedia, filename?: string | null): OpenAIChatCompletionsUserContentPart => {
  const name = filename == null ? {} : { filename };
  switch (media.source_kind) {
  case 'file': return { type: 'file', file: { file_id: media.file_id, ...name } };
  case 'data': return { type: 'file', file: { file_data: media.data, ...name } };
  case 'base64': return { type: 'file', file: { file_data: dataUrl(media, false), ...name } };
  case 'url': throw new TranslateInputException('Cannot translate a file URL to OpenAI Chat Completions.');
  }
};

const documentParts = (document: IRInputDocument): OpenAIChatCompletionsUserContentPart[] => {
  const source = document.source;
  const content = source.source_kind === 'media'
    ? [filePart(source.media)]
    : source.source_kind === 'text'
      ? [{ type: 'text' as const, text: source.text }]
      : source.content.map(part => part.type === 'text'
          ? { type: 'text' as const, text: part.text }
          : imageUrlPart(documentImage(part), part.detail));
  return [{ type: 'text', text: documentOpening(document) }, ...content, { type: 'text', text: DOCUMENT_CLOSE_TAG }];
};

const userContent = (item: Extract<IRInputClientItem, { type: 'message'; role: 'user' }>): string | OpenAIChatCompletionsUserContentPart[] => {
  if (item.content.every(part => part.type === 'text')) return item.content.map(part => part.text).join('');
  return item.content.flatMap(part => {
    switch (part.type) {
    case 'text': return { type: 'text' as const, text: part.text };
    case 'image': return imageUrlPart(part.image, part.detail);
    case 'file': return filePart(part.file, part.filename);
    case 'document': return documentParts(part.document);
    case 'audio': return { type: 'input_audio' as const, input_audio: { data: part.audio.data, format: audioFormat(part.audio.media_type) } };
    }
  });
};

/**
 * A Chat `tool` message admits only text, while the input IR tool result may carry
 * attachments. Image, file, and document parts are lifted into a user message
 * that follows the result, so the target still receives them.
 *
 * https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
 * https://github.com/vercel/ai/blob/c093ee7458ccd5dada05d8461041e47c24ee55c0/packages/google/src/convert-to-google-messages.ts#L137-L180
 */
const openaiChatCompletionsToolResultContent = (
  callId: string,
  output: string | readonly IRInputToolResultContentPart[],
): { readonly content: string; readonly lifted: OpenAIChatCompletionsUserContentPart[] } => {
  if (typeof output === 'string') return { content: output, lifted: [] };
  const text = output.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  const lifted = output.flatMap(part => part.type === 'image'
    ? [imageUrlPart(part.image, part.detail)]
    : part.type === 'file' ? [filePart(part.file, part.filename)]
      : part.type === 'document' ? documentParts(part.document) : []);
  if (lifted.length === 0) return { content: text, lifted: [] };
  const kinds = new Set(output.flatMap(part => part.type === 'image' || part.type === 'file' || part.type === 'document' ? [part.type] : []));
  const noun = kinds.size > 1 ? 'Attachments' : kinds.has('image') ? 'Image output' : kinds.has('file') ? 'File output' : 'Document output';
  return {
    content: text === '' ? `${noun} is attached in the following user message.` : text,
    lifted: [{ type: 'text', text: `${noun} from tool call ${callId}:` }, ...lifted],
  };
};

const assistantMessage = (items: readonly IRInputAssistantItemWithCallIds[]): OpenAIChatCompletionsMessage[] => {
  const text: string[] = [];
  const refusals: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: OpenAIChatCompletionsToolCall[] = [];
  let hasMessage = false;
  for (const item of items) {
    switch (item.type) {
    case 'message':
      hasMessage = true;
      for (const part of item.content) if (part.type === 'text') text.push(part.text); else refusals.push(part.refusal);
      break;
    case 'reasoning':
      // We write readable reasoning as reasoning_text; input IR does not retain the source alias spelling.
      if (item.summary !== undefined) reasoning.push(item.summary.join(''));
      if (item.content !== undefined) reasoning.push(item.content.join(''));
      break;
    case 'function_call':
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        // Chat requires argument text; omitted source arguments use an empty JSON object.
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
      break;
    case 'custom_tool_call':
      // Freeform calls use the same function wrapper as their declarations; the response path restores the custom shape.
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: JSON.stringify({ input: item.input }) } });
      break;
    }
  }
  if (!hasMessage && toolCalls.length === 0 && reasoning.length === 0) return [];
  // A turn carrying reasoning or tool calls with no text spells its content as
  // null; a turn with neither is an explicitly empty message and keeps ''.
  return [{
    role: 'assistant',
    content: text.length === 0 && (toolCalls.length > 0 || reasoning.length > 0) ? null : text.join(''),
    ...(refusals.length === 0 ? {} : { refusal: refusals.join('') }),
    ...(reasoning.length === 0 ? {} : { reasoning_text: reasoning.join('') }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  }];
};

const clientMessages = (
  items: readonly IRInputClientItemWithCallIds[],
  legacyCallNames: ReadonlyMap<string, string>,
): OpenAIChatCompletionsMessage[] => {
  // Attachments lifted out of consecutive tool results gather into one user message
  // after the run, so a tool-call group stays contiguous.
  const messages: OpenAIChatCompletionsMessage[] = [];
  let pendingAttachments: OpenAIChatCompletionsUserContentPart[] = [];
  const flushAttachments = (): void => {
    if (pendingAttachments.length === 0) return;
    messages.push({ role: 'user', content: pendingAttachments });
    pendingAttachments = [];
  };
  for (const item of items) {
    if (item.type !== 'tool_result') flushAttachments();
    messages.push(...openaiChatCompletionsClientItem(item, lifted => pendingAttachments.push(...lifted), legacyCallNames));
  }
  flushAttachments();
  return messages;
};

const openaiChatCompletionsClientItem = (
  item: IRInputClientItemWithCallIds,
  lift: (parts: readonly OpenAIChatCompletionsUserContentPart[]) => void,
  legacyCallNames: ReadonlyMap<string, string>,
): OpenAIChatCompletionsMessage[] => {
  switch (item.type) {
  case 'message':
  case 'instruction': {
    if (item.type === 'message' && item.role === 'user') return [{ role: 'user', content: userContent(item) }];
    return [{ role: item.type === 'instruction' ? 'system' : item.role, content: item.content.length === 1 ? item.content[0].text : item.content.length === 0 ? '' : item.content.map(part => ({ type: 'text' as const, text: part.text })) }];
  }
  case 'tool_result': {
    const projected = openaiChatCompletionsToolResultContent(item.call_id, item.output);
    lift(projected.lifted);
    // This wire pairs a legacy `function_call` with a `function` message by
    // name, and a call that states an id with a `tool` message by that id.
    // Answering a legacy call with a `tool` message would name an id no
    // assistant turn ever stated.
    const legacyCallName = legacyCallNames.get(item.call_id);
    return [legacyCallName === undefined
      ? { role: 'tool', tool_call_id: item.call_id, content: projected.content }
      : { role: 'function', name: legacyCallName, content: projected.content }];
  }
  }
};

export const openaiChatCompletionsConversationFromIR = (
  turns: readonly IRInputTurnWithCallIds[],
  legacyCallNames: ReadonlyMap<string, string>,
): OpenAIChatCompletionsMessage[] => turns.flatMap(turn => turn.kind === 'assistant'
  ? assistantMessage(turn.items)
  : clientMessages(turn.items, legacyCallNames));

// OpenAI's strict-mode validators reject an object schema without `properties`,
// which is a target-side constraint rather than something the IR states.
const normalizeParameters = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  schema.type === 'object' && schema.properties === undefined ? { ...schema, properties: {} } : schema;

const toolFromIR = (tool: IRInputTool): OpenAIChatCompletionsTool => {
  if (tool.type === 'custom') {
    // Chat accepts a freeform declaration natively, but not every upstream that
    // speaks the Chat wire accepts one, so a freeform tool is projected onto the
    // function shape that states its single raw string. The caller records the
    // name so returned function calls can be restored to freeform calls.
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: buildCustomToolInputSchema(tool.format),
        strict: false,
      },
    };
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.parameters === undefined ? {} : { parameters: normalizeParameters(tool.parameters) }),
      // Keep omitted strictness absent so the Chat target applies its own default.
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
};

const toolChoiceFromIR = (choice: IRInputToolChoice): NonNullable<OpenAIChatCompletionsPayload['tool_choice']> => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'allowed_tools') return {
    type: 'allowed_tools',
    allowed_tools: {
      mode: choice.mode,
      tools: choice.tools.map(tool => ({ type: 'function', function: { name: tool.name } })),
    },
  };
  // A freeform declaration is written as a function tool, so a selector naming
  // it must name the same function.
  return { type: 'function', function: { name: choice.name } };
};

/**
 * Everything a Chat Completions request states except its messages.
 *
 * The conversation is written separately because a trip interleaves it with the
 * assistant turns a sidecar already resolved, so only this half is computed once
 * per payload.
 */
export const openaiChatCompletionsHeaderFromIR = (request: IRInputRequestHeader): Omit<OpenAIChatCompletionsPayload, 'messages'> => {
  const tools = request.tools;
  const choice = tools === undefined || tools.length === 0 ? request.tool_choice === 'required' ? 'required' : undefined : request.tool_choice;
  return {
    ...openaiChatCompletionsSettingsFromIR(request.settings),
    model: request.settings.model,
    // A trip guarantees a streaming request; a request that says otherwise
    // cannot be carried by this side at all.
    stream: requireStreaming(request.settings),
    // Request final usage and the vLLM extension for cumulative usage on each chunk.
    // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/generate/base/protocol.py#L241-L243
    stream_options: { include_usage: true, continuous_usage_stats: true } as OpenAIChatCompletionsStreamOptionsEx,
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolFromIR) }),
    ...(choice === undefined ? {} : { tool_choice: toolChoiceFromIR(choice) }),
  };
};

/** A numeric budget approximates effort only when the caller supplied no level. */
const chatReasoningEffort = (settings: IRInputSettings): string | undefined =>
  settings.reasoning_effort ?? (settings.reasoning_budget === undefined ? undefined : reasoningEffortForBudget(settings.reasoning_budget));

export const openaiChatCompletionsSettingsFromIR = (settings: IRInputSettings): Partial<OpenAIChatCompletionsPayload> => {
  const ceiling = settings.max_output_tokens !== undefined ? settings.max_output_tokens : settings.max_visible_output_tokens;
  const format = settings.output_format;
  const reasoningEffort = chatReasoningEffort(settings);

  return {
    // State both cap spellings. OpenAI uses the replacement
    // `max_completion_tokens`, while compatible targets such as Ollama still
    // read only `max_tokens`.
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
    // https://github.com/ollama/ollama/blob/c1db5f9/openai/openai.go
    ...(ceiling === undefined ? {} : { max_tokens: ceiling, max_completion_tokens: ceiling }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
    ...(settings.stop === undefined ? {} : { stop: [...settings.stop] }),
    ...(settings.seed === undefined ? {} : { seed: settings.seed }),
    ...(settings.metadata === undefined ? {} : { metadata: settings.metadata }),
    ...(settings.store === undefined ? {} : { store: settings.store }),
    ...(settings.service_tier === undefined ? {} : { service_tier: settings.service_tier }),
    ...(settings.parallel_tool_calls == null ? {} : { parallel_tool_calls: settings.parallel_tool_calls }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(settings.prompt_cache_key === undefined ? {} : { prompt_cache_key: settings.prompt_cache_key }),
    ...(settings.prompt_cache_retention === undefined ? {} : { prompt_cache_retention: settings.prompt_cache_retention }),
    ...(settings.prompt_cache_options === undefined ? {} : { prompt_cache_options: settings.prompt_cache_options }),
    ...(settings.safety_identifier === undefined ? {} : { safety_identifier: settings.safety_identifier }),
    ...(settings.user === undefined ? {} : { user: settings.user }),
    ...(settings.logprobs === undefined ? {} : { logprobs: settings.logprobs }),
    ...(settings.top_logprobs === undefined ? {} : { top_logprobs: settings.top_logprobs }),
    ...(settings.verbosity === undefined ? {} : { verbosity: settings.verbosity }),
    ...(settings.choice_count === undefined ? {} : { n: settings.choice_count }),
    ...(settings.presence_penalty === undefined ? {} : { presence_penalty: settings.presence_penalty }),
    ...(settings.frequency_penalty === undefined ? {} : { frequency_penalty: settings.frequency_penalty }),
    ...(format === undefined
      ? {}
      : format.type === 'json_schema'
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: {
                name: format.name ?? 'response',
                ...(format.description === undefined ? {} : { description: format.description }),
                ...(format.schema === undefined ? {} : { schema: format.schema }),
                ...(format.strict === undefined ? {} : { strict: format.strict }),
              },
            },
          }
        : { response_format: { type: format.type } }),
  };
};
