import { v5 as uuidV5 } from 'uuid';

import { chatgptModelUsesResponsesLite } from '../../models.ts';
import { chatgptFactSpace } from '../facts.ts';
import { responsesIdentity, type ChatGPTResponsesRequestBody } from './request.ts';
import type { HttpHeaders } from '@floway-dev/http';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesAssistantInputContent,
  OpenAIResponsesInputAdditionalToolsItem,
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputContent,
  OpenAIResponsesInputMessage,
  OpenAIResponsesStreamEventEx,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';
import type { ProviderModelFact } from '@floway-dev/provider';

export type ChatGPTResponsesBody = Omit<CanonicalOpenAIResponsesPayload, 'model'>;

export interface ChatGPTResponsesLiteRequest<Body = ChatGPTResponsesBody> {
  body: Body;
  movedFields: {
    tools?: OpenAIResponsesTool[];
    instructions?: string;
  };
}

// Official Codex groups flat function/custom tools under `functions` and tags
// the base-instructions developer message when selecting Responses Lite.
// https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/tools/src/tool_spec.rs#L95-L142
// https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client.rs#L902-L939
const DEFAULT_FUNCTION_NAMESPACE = 'functions';
const BASE_INSTRUCTIONS_CONTENT_KIND = 'model.base_instructions';
// RFC 9562's namespace UUID for ISO object identifiers, matching
// `Uuid::NAMESPACE_OID` in Codex's stable prefix ID derivation.
// https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client.rs#L902-L965
// https://www.rfc-editor.org/rfc/rfc9562.html#name-namespace-id-usage-and-allo
const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCallableTool = (
  value: unknown,
): value is Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }> =>
  isRecord(value)
  && (value.type === 'function' || value.type === 'custom')
  && typeof value.name === 'string';

const isNamespaceTool = (
  value: unknown,
): value is Extract<OpenAIResponsesTool, { type: 'namespace' }> =>
  isRecord(value)
  && value.type === 'namespace'
  && typeof value.name === 'string'
  && typeof value.description === 'string'
  && Array.isArray(value.tools);

const isAdditionalToolsItem = (
  value: unknown,
): value is OpenAIResponsesInputAdditionalToolsItem =>
  isRecord(value)
  && value.type === 'additional_tools'
  && value.role === 'developer'
  && Array.isArray(value.tools)
  && (value.id === undefined || value.id === null || typeof value.id === 'string');

const toolsForLite = (tools: readonly OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
  const output: OpenAIResponsesTool[] = [];
  const functionChildren: Array<Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>> = [];
  let functionDescription = '';
  let functionIndex: number | undefined;

  for (const tool of tools) {
    if (isCallableTool(tool)) {
      functionIndex ??= output.length;
      functionChildren.push(tool);
      continue;
    }
    if (isNamespaceTool(tool) && tool.name === DEFAULT_FUNCTION_NAMESPACE) {
      functionIndex ??= output.length;
      if (tool.description.trim() !== '') functionDescription = tool.description;
      for (const child of tool.tools) functionChildren.push(child);
      continue;
    }
    output.push(tool);
  }

  if (functionIndex !== undefined && functionChildren.length > 0) {
    output.splice(functionIndex, 0, {
      type: 'namespace',
      name: DEFAULT_FUNCTION_NAMESPACE,
      description: functionDescription,
      tools: functionChildren,
    });
  }
  return output;
};

const makeAdditionalToolsItem = (
  tools: OpenAIResponsesTool[],
  threadNamespace: string,
): OpenAIResponsesInputAdditionalToolsItem => ({
  type: 'additional_tools',
  role: 'developer',
  tools,
  id: `at_${uuidV5(JSON.stringify(tools), threadNamespace)}`,
});

const makeBaseInstructionsMessage = (
  instructions: string,
  threadNamespace: string,
): OpenAIResponsesInputMessage => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: instructions }],
  id: `msg_${uuidV5(instructions, threadNamespace)}`,
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: [BASE_INSTRUCTIONS_CONTENT_KIND],
  },
});

// Codex strips image detail only from message and callable-output image content.
// https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client_common.rs#L59-L117
const hasInputImageDetail = (part: OpenAIResponsesAssistantInputContent): boolean =>
  part.type === 'input_image' && 'detail' in part;

const removeInputImageDetail = (part: OpenAIResponsesInputContent): OpenAIResponsesInputContent => {
  if (part.type !== 'input_image' || !hasInputImageDetail(part)) return part;
  const { detail: _detail, ...image } = part;
  return image;
};

const removeLiteImageDetail = (item: CanonicalOpenAIResponsesInputItem): CanonicalOpenAIResponsesInputItem => {
  if (item.type === 'message' && Array.isArray(item.content)) {
    if (!item.content.some(hasInputImageDetail)) return item;
    return item.role === 'assistant'
      ? { ...item, content: item.content.map(part => part.type === 'refusal' ? part : removeInputImageDetail(part)) }
      : { ...item, content: item.content.map(removeInputImageDetail) };
  }
  if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output) && item.output.some(hasInputImageDetail)) {
    return { ...item, output: item.output.map(removeInputImageDetail) };
  }
  return item;
};

type LiteBody<Body> = Omit<Body, 'tools' | 'instructions' | 'input' | 'parallel_tool_calls' | 'reasoning'> &
  Pick<ChatGPTResponsesRequestBody, 'input' | 'parallel_tool_calls' | 'reasoning'>;

export const encodeChatGPTResponsesLiteRequest = <Body extends ChatGPTResponsesRequestBody>(
  { tools, instructions, input: originalInput, parallel_tool_calls: _parallelToolCalls, reasoning, ...body }: Body,
  threadId: string,
): ChatGPTResponsesLiteRequest<LiteBody<Body>> => {
  const topLevelTools = Array.isArray(tools) ? tools : [];
  const input: CanonicalOpenAIResponsesInputItem[] = [...originalInput];
  const threadNamespace = uuidV5(threadId, UUID_NAMESPACE_OID);

  // Existing `additional_tools` items are positional Responses input. A new
  // prefix contains only tools that came from the request's top-level field.
  // https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input
  const hasInstructions = typeof instructions === 'string' && instructions.length > 0;
  const needsToolsPrefix = Array.isArray(tools) || !originalInput.some(isAdditionalToolsItem) || hasInstructions;
  if (needsToolsPrefix) input.unshift(makeAdditionalToolsItem(toolsForLite(topLevelTools), threadNamespace));
  if (hasInstructions) input.splice(1, 0, makeBaseInstructionsMessage(instructions, threadNamespace));

  // These are model-side Lite wire controls set by official Codex. Other
  // request fields, including tool_choice, retain their caller values.
  // https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client.rs#L876-L1000
  return {
    body: {
      ...body,
      input: input.map(removeLiteImageDetail),
      parallel_tool_calls: false,
      reasoning: { ...(isRecord(reasoning) ? reasoning : {}), context: 'all_turns' },
    },
    movedFields: {
      ...(Array.isArray(tools) ? { tools } : {}),
      ...(hasInstructions ? { instructions } : {}),
    },
  };
};

// A Standard caller's top-level fields were moved into Lite input items. Show
// those fields in its response resource; preserve output items, event families,
// and all other response fields. Positional Lite callers move no top-level
// fields and bypass this projection entirely.
const projectMovedChatGPTResponsesFields = (
  event: OpenAIResponsesStreamEventEx,
  movedFields: ChatGPTResponsesLiteRequest['movedFields'],
): OpenAIResponsesStreamEventEx => {
  if (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress'
    || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
    return { ...event, response: { ...event.response, ...movedFields } };
  }
  return event;
};

const prepare = <Body extends ChatGPTResponsesRequestBody>(body: Body, headers: HttpHeaders, model: ProviderModelFact, compact: boolean) => {
  const identity = responsesIdentity(body, headers, compact);
  const encoded = chatgptModelUsesResponsesLite(model) ? encodeChatGPTResponsesLiteRequest(body, identity.threadId) : { body, movedFields: {} };
  return { identity, ...encoded };
};

const { defineStage } = chatgptFactSpace;

export const openaiResponsesLite = defineStage({
  name: 'chatgpt.openaiResponses.responses-lite',
  through: {
    request: { needs: ['request.http', 'request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses', 'request.chatgptResponsesIdentity'], consumes: [] },
    response: { needs: ['response.openaiResponses'], provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const { body, identity, movedFields } = prepare(facts['request.openaiResponses'], facts['request.http'].headers, facts['provider.model'], false);
    const answer = await scope.next({ ...facts, 'request.openaiResponses': body, 'request.chatgptResponsesIdentity': identity });
    const outcome = answer['response.openaiResponses'];
    if (outcome.kind !== 'stream' || Object.keys(movedFields).length === 0) return answer;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      for await (const item of producer.read(source)) {
        if (!item.ok) yield item;
        else yield { ok: true, value: projectMovedChatGPTResponsesFields(item.value, movedFields) };
      }
    });
    return { ...answer, 'response.openaiResponses': { kind: 'stream', stream } };
  },
});

export const openaiResponsesCompactLite = defineStage({
  name: 'chatgpt.openaiResponsesCompact.responses-lite',
  through: {
    request: { needs: ['request.http', 'request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact', 'request.chatgptResponsesIdentity'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { body, identity } = prepare(facts['request.openaiResponsesCompact'], facts['request.http'].headers, facts['provider.model'], true);
    return await scope.next({ ...facts, 'request.openaiResponsesCompact': body, 'request.chatgptResponsesIdentity': identity });
  },
});
