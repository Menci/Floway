import { v5 as uuidV5 } from 'uuid';

import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesCompactionResult,
  OpenAIResponsesInputAdditionalToolsItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesOutputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

export type CodexResponsesBody = Omit<CanonicalOpenAIResponsesPayload, 'model'>;

interface CallableIdentity {
  name: string;
  namespace?: string;
  type: 'function_call' | 'custom_tool_call';
}

type CallableEntries = Map<string, Map<string, CallableIdentity>>;

interface CodexResponsesCallableIdentityMap {
  readonly byNamespace: ReadonlyMap<string, ReadonlyMap<string, CallableIdentity>>;
}

type CodexResponsesRequestEchoes = Pick<CodexResponsesBody, 'tools' | 'instructions'>;

interface CodexResponsesGeneratedPrefixItem {
  item: OpenAIResponsesInputAdditionalToolsItem | CodexBaseInstructionsMessage;
  sourceItems: readonly OpenAIResponsesInputAdditionalToolsItem[];
  callerCopies: number;
}

export interface CodexResponsesLiteRequest {
  body: CodexResponsesBody;
  callableIdentities: CodexResponsesCallableIdentityMap;
  requestEchoes: CodexResponsesRequestEchoes;
  generatedPrefix: readonly CodexResponsesGeneratedPrefixItem[];
}

// Official Codex folds flat function/custom tools into this namespace and tags
// the following developer message with this content kind.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tools/src/tool_spec.rs#L95-L141
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/context/base_instructions.rs#L5-L12
const DEFAULT_FUNCTION_NAMESPACE = 'functions';
const BASE_INSTRUCTIONS_CONTENT_KIND = 'model.base_instructions';
// RFC 9562's namespace UUID for ISO object identifiers, matching
// `Uuid::NAMESPACE_OID` in official Codex's Responses Lite ID derivation.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L938-L965
// https://www.rfc-editor.org/rfc/rfc9562.html#name-namespace-id-usage-and-allo
const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

type CodexBaseInstructionsMessage = OpenAIResponsesInputMessage & {
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: string[];
  };
};

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

// Codex accepts absent and empty namespaces as the default function namespace.
// Use the same lookup for output items and their streaming event lifecycles.
// https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/tool_name.rs#L39-L44
const liteNamespace = (namespace: string | null | undefined): string =>
  namespace == null || namespace === '' ? DEFAULT_FUNCTION_NAMESPACE : namespace;

const lookupLiteCallable = (
  identities: CodexResponsesCallableIdentityMap,
  item: Pick<CallableIdentity, 'namespace' | 'name'>,
): CallableIdentity | undefined =>
  identities.byNamespace.get(liteNamespace(item.namespace))?.get(item.name);

const registerCallable = (
  entries: CallableEntries,
  wire: CallableIdentity,
  standard: CallableIdentity,
): void => {
  const namespace = liteNamespace(wire.namespace);
  let names = entries.get(namespace);
  if (names === undefined) {
    names = new Map();
    entries.set(namespace, names);
  }
  const current = names.get(wire.name);
  if (current !== undefined && (
    current.name !== standard.name || current.namespace !== standard.namespace || current.type !== standard.type
  )) {
    throw new TypeError(`Codex Responses Lite cannot preserve distinct callable identities for ${JSON.stringify([namespace, wire.name])}`);
  }
  names.set(wire.name, standard);
};

const identityForTool = (
  tool: Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>,
  namespace?: string,
): CallableIdentity => ({
  name: tool.name,
  ...(namespace === undefined ? {} : { namespace }),
  type: tool.type === 'function' ? 'function_call' : 'custom_tool_call',
});

const registerToolIdentities = (
  entries: CallableEntries,
  tool: OpenAIResponsesTool,
): void => {
  if (isCallableTool(tool)) {
    registerCallable(entries, identityForTool(tool, DEFAULT_FUNCTION_NAMESPACE), identityForTool(tool));
    return;
  }
  if (!isNamespaceTool(tool)) return;
  for (const child of tool.tools) {
    if (!isCallableTool(child)) continue;
    const identity = identityForTool(child, tool.name);
    registerCallable(entries, identity, identity);
  }
};

// Only these two declaration surfaces are consolidated into the Lite prefix.
// Search-loaded declarations stay at their input position and are inventoried
// separately, without becoming prefix tools.
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/util/responses_tools.go#L65-L73
const collectPrefixTools = (body: CodexResponsesBody): OpenAIResponsesTool[] => {
  const tools: OpenAIResponsesTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) tools.push(tool);
  }
  for (const item of body.input) {
    if (!isAdditionalToolsItem(item)) continue;
    for (const tool of item.tools) tools.push(tool);
  }
  return tools;
};

const toolsForLite = (
  tools: readonly OpenAIResponsesTool[],
): OpenAIResponsesTool[] => {
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
): CodexBaseInstructionsMessage => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: instructions }],
  id: `msg_${uuidV5(instructions, threadNamespace)}`,
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: [BASE_INSTRUCTIONS_CONTENT_KIND],
  },
});

// Codex strips this field only from message and callable-output image content;
// do not recurse into tool schemas, metadata, or unrelated extension objects.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client_common.rs#L56-L105
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

const removeLiteImageDetail = (
  item: OpenAIResponsesInputItem,
): OpenAIResponsesInputItem => {
  if (item.type === 'message' && Array.isArray(item.content)) {
    const content = removeInputImageDetails(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (
    (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
    && Array.isArray(item.output)
  ) {
    const output = removeInputImageDetails(item.output);
    return output === item.output ? item : { ...item, output };
  }
  return item;
};

// Prefix matching is structural rather than ID-only: caller history can carry
// the same metadata or IDs, and JSON object key order need not survive the wire.
const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
};

const matchesGeneratedPrefix = (
  item: OpenAIResponsesInputItem | OpenAIResponsesOutputItem,
  generated: CodexResponsesGeneratedPrefixItem['item'],
): boolean => item.type === generated.type && 'id' in item && item.id === generated.id && sameJsonValue(item, generated);

export const encodeCodexResponsesLiteRequest = (
  body: CodexResponsesBody,
  threadId: string,
): CodexResponsesLiteRequest => {
  const next: CodexResponsesBody = { ...body };
  const entries: CallableEntries = new Map();
  const tools = collectPrefixTools(body);
  for (const tool of tools) registerToolIdentities(entries, tool);
  // Search results declare callable identities at their existing history position.
  // Inventory them for inverse repair without moving or rewriting their tools.
  // https://github.com/openai/openai-node/blob/39a15b412fc129df15339ebd6e3e6547854aa81f/src/resources/responses/responses.ts#L7119-L7223
  for (const item of body.input) {
    if (item.type !== 'tool_search_output' || !Array.isArray(item.tools)) continue;
    for (const tool of item.tools) registerToolIdentities(entries, tool);
  }
  const threadNamespace = uuidV5(threadId, UUID_NAMESPACE_OID);
  const input: OpenAIResponsesInputItem[] = body.input.filter(item => !isAdditionalToolsItem(item));
  const toolsItem = makeAdditionalToolsItem(toolsForLite(tools), threadNamespace);
  const generatedPrefix: CodexResponsesGeneratedPrefixItem[] = [{
    item: toolsItem, sourceItems: body.input.filter(isAdditionalToolsItem), callerCopies: 0,
  }];
  input.unshift(toolsItem);
  if (Array.isArray(body.tools) || body.tools === null) delete next.tools;

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    const item = makeBaseInstructionsMessage(body.instructions, threadNamespace);
    generatedPrefix.push({
      item, sourceItems: [], callerCopies: body.input.filter(source => matchesGeneratedPrefix(source, item)).length,
    });
    input.splice(1, 0, item);
    delete next.instructions;
  } else if (body.instructions === undefined || body.instructions === null || body.instructions === '') {
    delete next.instructions;
  }

  next.input = input.map(removeLiteImageDetail);
  // These are model-side Lite wire controls, not caller preferences. Codex uses
  // "auto" for tool_choice in both formats; preserve the caller's value without
  // inventing a different structured-choice representation.
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L920-L924
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L1014-L1021
  next.parallel_tool_calls = false;
  next.reasoning = {
    ...(isRecord(body.reasoning) ? body.reasoning : {}),
    context: 'all_turns',
  };

  return {
    body: next,
    callableIdentities: { byNamespace: entries },
    generatedPrefix,
    // Resource-bearing events echo request fields in the upstream format.
    // https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go
    requestEchoes: {
      tools: body.tools,
      instructions: body.instructions,
    },
  };
};

// Restore the Standard namespace and function/custom identity from the request
// map, mirroring CLIProxyAPI's streaming and unary response repair.
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go#L288-L445
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go#L779-L963
const restoreCallableItem = (
  item: OpenAIResponsesOutputItem,
  identities: CodexResponsesCallableIdentityMap,
  missingStatus: 'in_progress' | 'completed' = 'completed',
): OpenAIResponsesOutputItem => {
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
  const standard = lookupLiteCallable(identities, item);
  if (standard === undefined || (
    item.type === standard.type && item.name === standard.name && item.namespace === standard.namespace
  )) return item;

  const restored = { ...item } as Record<string, unknown>;
  restored.name = standard.name;
  if (standard.namespace === undefined) delete restored.namespace;
  else restored.namespace = standard.namespace;

  if (standard.type === 'function_call') {
    restored.type = 'function_call';
    if (item.type === 'custom_tool_call') {
      restored.arguments = item.input;
      delete restored.input;
      if (restored.status === undefined) restored.status = missingStatus;
    }
  } else {
    restored.type = 'custom_tool_call';
    if (item.type === 'function_call') {
      restored.input = item.arguments;
      delete restored.arguments;
    }
  }

  return restored as unknown as OpenAIResponsesOutputItem;
};

// Only these fields changed representation. Reasoning (including context) and
// parallel_tool_calls report effective upstream settings, not request echoes.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/shared.ts#L262-L269
const REQUEST_ECHO_FIELDS = ['tools', 'instructions'] as const;

export const restoreCodexResponsesResult = (
  result: OpenAIResponsesResult,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
  missingStatus: 'in_progress' | 'completed' = result.status === 'queued' || result.status === 'in_progress' ? 'in_progress' : 'completed',
): OpenAIResponsesResult => {
  const restored = {
    ...result,
    output: result.output.map(item => restoreCallableItem(item, identities, missingStatus)),
  };
  if (requestEchoes !== undefined) {
    const record = restored as unknown as Record<string, unknown>;
    for (const field of REQUEST_ECHO_FIELDS) {
      const value = requestEchoes[field];
      if (value === undefined) delete record[field];
      else record[field] = value;
    }
  }
  return restored;
};

// Remote compact output can retain instruction/tool prefixes. Unlike Codex's
// session-specific filter, this boundary must keep caller-owned developer items.
// Invert one matching generated representation, never an entire item family.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/compact_remote.rs
const restoreCompactedPrefix = (
  output: OpenAIResponsesOutputItem[],
  generatedPrefix: readonly CodexResponsesGeneratedPrefixItem[],
): OpenAIResponsesOutputItem[] => {
  let restored = output;
  for (const generated of generatedPrefix) {
    const matches = restored.filter(item => matchesGeneratedPrefix(item, generated.item));
    // Identical caller history makes a lone echo ambiguous. Preserve those
    // copies, and consume at most the one extra representation we generated.
    if (matches.length <= generated.callerCopies) continue;
    let replaced = false;
    restored = restored.flatMap(item => {
      if (replaced || !matchesGeneratedPrefix(item, generated.item)) return [item];
      replaced = true;
      // Only input carriers were merged into this prefix; top-level tools and
      // instructions remain request fields, so they contribute no history here.
      return generated.sourceItems as readonly OpenAIResponsesOutputItem[];
    });
  }
  return restored;
};

export const restoreCodexResponsesCompactionResult = (
  result: OpenAIResponsesCompactionResult,
  identities: CodexResponsesCallableIdentityMap,
  generatedPrefix: readonly CodexResponsesGeneratedPrefixItem[] = [],
): OpenAIResponsesCompactionResult => ({
  ...result,
  output: restoreCompactedPrefix(result.output, generatedPrefix).map(item => restoreCallableItem(item, identities)),
});

export const restoreCodexResponsesEvent = (
  event: OpenAIResponsesStreamEvent,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
): OpenAIResponsesStreamEvent => {
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    return { ...event, item: restoreCallableItem(event.item, identities, event.type === 'response.output_item.added' ? 'in_progress' : 'completed') };
  }
  if (
    (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress'
      || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')
    && isRecord(event.response) && Array.isArray(event.response.output)
  ) {
    return {
      ...event,
      response: restoreCodexResponsesResult(
        event.response as unknown as OpenAIResponsesResult,
        identities,
        requestEchoes,
        event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress' ? 'in_progress' : 'completed',
      ),
    } as OpenAIResponsesStreamEvent;
  }
  return event;
};

// Callable input events carry item_id, not the tool identity. A converted item
// must keep the same family through its delta/done events; done uses arguments
// for functions (with a name) and input for custom tools.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts
const restoreCallableInputEvent = (
  event: OpenAIResponsesStreamEvent,
  identitiesByItemId: ReadonlyMap<string, CallableIdentity>,
): OpenAIResponsesStreamEvent => {
  if (!('item_id' in event)) return event;
  const identity = identitiesByItemId.get(event.item_id);
  if (identity === undefined) return event;
  switch (event.type) {
  case 'response.function_call_arguments.delta':
    return identity.type === 'custom_tool_call' ? { ...event, type: 'response.custom_tool_call_input.delta' } : event;
  case 'response.custom_tool_call_input.delta':
    return identity.type === 'function_call' ? { ...event, type: 'response.function_call_arguments.delta' } : event;
  case 'response.function_call_arguments.done': {
    if (identity.type !== 'custom_tool_call') return event;
    const { arguments: input, ...restored } = event;
    return { ...restored, type: 'response.custom_tool_call_input.done', input };
  }
  case 'response.custom_tool_call_input.done': {
    if (identity.type !== 'function_call') return event;
    const { input: args, ...restored } = event;
    return {
      ...restored, type: 'response.function_call_arguments.done', arguments: args,
      ...(!('name' in restored) || restored.name === undefined ? { name: identity.name } : {}),
    };
  }
  default:
    return event;
  }
};

export const restoreCodexResponsesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const identitiesByItemId = new Map<string, CallableIdentity>();
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }
    const event = frame.event;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = event.item;
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.id === 'string') {
        const standard = lookupLiteCallable(identities, item);
        if (standard !== undefined && standard.type !== item.type) identitiesByItemId.set(item.id, standard);
      }
    }
    yield {
      ...frame,
      event: restoreCallableInputEvent(restoreCodexResponsesEvent(event, identities, requestEchoes), identitiesByItemId),
    };
  }
};
