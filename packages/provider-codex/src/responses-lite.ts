import { v5 as uuidV5 } from 'uuid';

import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputAdditionalToolsItem,
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputMessageEx,
  OpenAIResponsesStreamEventEx,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

export type CodexResponsesBody = Omit<CanonicalOpenAIResponsesPayload, 'model'>;

export interface CodexResponsesLiteRequest {
  body: CodexResponsesBody;
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
): OpenAIResponsesInputMessageEx => ({
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
const removeInputImageDetail = <T extends { type: string }>(part: T): T => {
  if (part.type !== 'input_image' || !('detail' in part)) return part;
  const next = { ...part };
  delete (next as { detail?: unknown }).detail;
  return next;
};

const removeInputImageDetails = <T extends { type: string }>(parts: T[]): T[] =>
  parts.some(part => part.type === 'input_image' && 'detail' in part)
    ? parts.map(removeInputImageDetail)
    : parts;

const removeLiteImageDetail = (item: CanonicalOpenAIResponsesInputItem): CanonicalOpenAIResponsesInputItem => {
  if (item.type === 'message' && Array.isArray(item.content)) {
    const content = removeInputImageDetails(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
    const output = removeInputImageDetails(item.output);
    return output === item.output ? item : { ...item, output };
  }
  return item;
};

export const encodeCodexResponsesLiteRequest = (
  body: CodexResponsesBody,
  threadId: string,
): CodexResponsesLiteRequest => {
  const next: CodexResponsesBody = { ...body };
  const topLevelTools = Array.isArray(body.tools) ? body.tools : [];
  const input: CanonicalOpenAIResponsesInputItem[] = [...body.input];
  const threadNamespace = uuidV5(threadId, UUID_NAMESPACE_OID);

  // Existing `additional_tools` items are positional Responses input. A new
  // prefix contains only tools that came from the request's top-level field.
  // https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input
  const needsToolsPrefix = Array.isArray(body.tools) || !body.input.some(isAdditionalToolsItem)
    || (typeof body.instructions === 'string' && body.instructions.length > 0);
  if (needsToolsPrefix) input.unshift(makeAdditionalToolsItem(toolsForLite(topLevelTools), threadNamespace));
  if (Array.isArray(body.tools) || body.tools === null) delete next.tools;

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    input.splice(1, 0, makeBaseInstructionsMessage(body.instructions, threadNamespace));
    delete next.instructions;
  } else if (body.instructions === undefined || body.instructions === null || body.instructions === '') {
    delete next.instructions;
  }

  next.input = input.map(removeLiteImageDetail);
  // These are model-side Lite wire controls set by official Codex. Other
  // request fields, including tool_choice, retain their caller values.
  // https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client.rs#L876-L1000
  next.parallel_tool_calls = false;
  next.reasoning = {
    ...(isRecord(body.reasoning) ? body.reasoning : {}),
    context: 'all_turns',
  };
  return {
    body: next,
    movedFields: {
      ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
      ...(typeof body.instructions === 'string' && body.instructions.length > 0 ? { instructions: body.instructions } : {}),
    },
  };
};

// A Standard caller's top-level fields were moved into Lite input items. Show
// those fields in its response resource; preserve output items, event families,
// and all other response fields. Positional Lite callers move no top-level
// fields and bypass this projection entirely.
export const projectMovedCodexResponsesFields = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  movedFields: CodexResponsesLiteRequest['movedFields'],
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    if (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress'
      || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      yield { ...frame, event: { ...event, response: { ...event.response, ...movedFields } } };
    } else yield frame;
  }
};
