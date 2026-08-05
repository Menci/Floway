import type { ResponsesInterceptor } from './types.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import {
  RESPONSES_INTER_AGENT_MESSAGE_ACTIONS,
  type CanonicalResponsesPayload,
  type ResponsesInputItem,
  type ResponsesHostedTool,
  type ResponsesOutputItem,
  type ResponsesResult,
  type ResponsesStreamEvent,
  type ResponsesTool,
  type ResponsesToolChoice,
} from '@floway-dev/protocols/responses';
import type { ChatTargetApi } from '@floway-dev/provider';

const CLIENT_NAMESPACE = 'collaboration';
const UPSTREAM_NAMESPACE_PREFIX = 'collaboration_';
const MESSAGE_ACTIONS = new Set<string>(RESPONSES_INTER_AGENT_MESSAGE_ACTIONS);

type NamespaceTool = ResponsesHostedTool & {
  name: string;
  tools: ResponsesTool[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const namespaceTool = (tool: ResponsesTool): NamespaceTool | undefined =>
  tool.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)
    ? tool as NamespaceTool
    : undefined;

const toolInventories = (payload: CanonicalResponsesPayload): Array<readonly ResponsesTool[] | null | undefined> => [
  payload.tools,
  ...payload.input.flatMap(item =>
    item.type === 'additional_tools' || item.type === 'tool_search_output' ? [item.tools] : []),
];

export const hasCollaborationNamespace = (payload: CanonicalResponsesPayload): boolean =>
  toolInventories(payload).some(tools =>
    (tools ?? []).some(tool => namespaceTool(tool)?.name === CLIENT_NAMESPACE));

export const supportsPlaintextCollaborationTarget = (
  payload: CanonicalResponsesPayload,
  targetApi: ChatTargetApi,
): boolean => {
  if (!hasCollaborationNamespace(payload)) return true;
  if (targetApi === 'responses') return true;
  if (targetApi === 'chat-completions') return false;
  const deferredCollaboration = payload.input.some(item =>
    (item.type === 'additional_tools' || item.type === 'tool_search_output')
    && item.tools.some(tool => namespaceTool(tool)?.name === CLIENT_NAMESPACE));
  if (deferredCollaboration) return false;
  const choice = payload.tool_choice;
  if (!isRecord(choice)) return true;
  const choiceRecord = choice as Record<string, unknown>;
  return choice.type !== 'allowed_tools'
    && choice.type !== 'namespace'
    && typeof choiceRecord.namespace !== 'string';
};

const namespaceNames = (payload: CanonicalResponsesPayload): Set<string> => {
  const names = new Set<string>();
  for (const tools of toolInventories(payload)) {
    for (const tool of tools ?? []) {
      if (tool.type === 'namespace' && typeof tool.name === 'string') names.add(tool.name);
    }
  }
  for (const item of payload.input) {
    if (item.type === 'function_call' && item.namespace !== undefined) names.add(item.namespace);
  }
  return names;
};

const upstreamNamespace = (occupied: ReadonlySet<string>): string => {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${UPSTREAM_NAMESPACE_PREFIX}${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
};

const rewriteMessageSchema = (tool: ResponsesTool, encrypted: boolean): ResponsesTool => {
  if (tool.type !== 'function' || !MESSAGE_ACTIONS.has(tool.name) || !isRecord(tool.parameters)) return tool;
  const properties = tool.parameters.properties;
  if (!isRecord(properties) || !isRecord(properties.message)) return tool;
  const message = { ...properties.message };
  if (encrypted) message.encrypted = true;
  else delete message.encrypted;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...properties, message },
    },
  };
};

const rewriteTools = (
  tools: readonly ResponsesTool[] | null | undefined,
  fromNamespace: string,
  toNamespace: string,
  encrypted: boolean,
): ResponsesTool[] | null | undefined => {
  if (tools == null) return tools;
  return tools.map(tool => {
    const namespace = namespaceTool(tool);
    if (namespace?.name !== fromNamespace) return tool;
    return {
      ...namespace,
      name: toNamespace,
      tools: namespace.tools.map(child => rewriteMessageSchema(child, encrypted)),
    };
  });
};

const rewriteToolChoice = (
  toolChoice: ResponsesToolChoice | null | undefined,
  fromNamespace: string,
  toNamespace: string,
): ResponsesToolChoice | null | undefined => {
  if (!isRecord(toolChoice)) return toolChoice;
  const rewriteQualifiedName = (name: unknown): unknown =>
    typeof name === 'string' && name.startsWith(`${fromNamespace}.`)
      ? `${toNamespace}.${name.slice(fromNamespace.length + 1)}`
      : name;
  const rewritten: Record<string, unknown> = { ...toolChoice };
  if (rewritten.namespace === fromNamespace) rewritten.namespace = toNamespace;
  if (rewritten.type === 'namespace' && rewritten.name === fromNamespace) rewritten.name = toNamespace;
  else rewritten.name = rewriteQualifiedName(rewritten.name);
  if (Array.isArray(rewritten.tools)) {
    rewritten.tools = rewritten.tools.map(tool => {
      if (!isRecord(tool)) return tool;
      const entry = { ...tool };
      if (entry.namespace === fromNamespace) entry.namespace = toNamespace;
      if (entry.type === 'namespace' && entry.name === fromNamespace) entry.name = toNamespace;
      else entry.name = rewriteQualifiedName(entry.name);
      return entry;
    });
  }
  return rewritten as ResponsesToolChoice;
};

const requestItem = (item: ResponsesInputItem, upstreamNamespace: string): ResponsesInputItem => {
  if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
    return {
      ...item,
      tools: rewriteTools(item.tools, CLIENT_NAMESPACE, upstreamNamespace, false) ?? [],
    };
  }
  if (item.type !== 'function_call' || item.namespace !== CLIENT_NAMESPACE) return item;
  // Codex removes this marker from replay for providers not named exactly
  // `OpenAI`, including Floway. Absence must therefore remain the plaintext
  // replay form; explicit null/non-empty values still prove encrypted mode.
  // https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/client.rs#L848-L860
  if (
    MESSAGE_ACTIONS.has(item.name)
    && item.encrypted_function_args !== undefined
    && (!Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length > 0)
  ) {
    throw new TypeError(`Cannot project encrypted collaboration history '${item.name}' onto a plaintext upstream`);
  }
  const { encrypted_function_args: _plaintextMarker, ...rest } = item;
  return { ...rest, namespace: upstreamNamespace };
};

const clientItem = (item: ResponsesOutputItem, upstreamNamespace: string): ResponsesOutputItem => {
  if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
    return {
      ...item,
      tools: rewriteTools(item.tools, upstreamNamespace, CLIENT_NAMESPACE, true) ?? [],
    };
  }
  if (item.type !== 'function_call' || item.namespace !== upstreamNamespace) return item;
  if (
    MESSAGE_ACTIONS.has(item.name)
    && item.encrypted_function_args !== undefined
    && (!Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length > 0)
  ) {
    throw new TypeError(`Plaintext collaboration upstream returned encrypted arguments for '${item.name}'`);
  }
  return {
    ...item,
    namespace: CLIENT_NAMESPACE,
    ...(MESSAGE_ACTIONS.has(item.name) ? { encrypted_function_args: [] } : {}),
  };
};

const clientResponse = (response: ResponsesResult, upstreamNamespace: string): ResponsesResult => {
  const record = response as ResponsesResult & { tools?: ResponsesTool[] | null };
  return {
    ...response,
    output: response.output.map(item => clientItem(item, upstreamNamespace)),
    ...(Object.hasOwn(record, 'tools')
      ? { tools: record.tools === null ? null : rewriteTools(record.tools, upstreamNamespace, CLIENT_NAMESPACE, true) }
      : {}),
    ...(response.tool_choice !== undefined
      ? { tool_choice: rewriteToolChoice(response.tool_choice, upstreamNamespace, CLIENT_NAMESPACE) }
      : {}),
  } as ResponsesResult;
};

const clientEvent = (event: ResponsesStreamEvent, upstreamNamespace: string): ResponsesStreamEvent => {
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    return { ...event, item: clientItem(event.item, upstreamNamespace) };
  }
  if (
    event.type === 'response.queued'
    || event.type === 'response.created'
    || event.type === 'response.in_progress'
    || event.type === 'response.completed'
    || event.type === 'response.incomplete'
    || event.type === 'response.failed'
  ) {
    return { ...event, response: clientResponse(event.response, upstreamNamespace) };
  }
  return event;
};

// Copilot reserves the exact `collaboration` namespace schema used by Codex,
// while Codex explicitly supports plaintext collaboration calls marked by an
// empty `encrypted_function_args` list. A request-scoped ordinary namespace
// lets the upstream produce plaintext; the client-facing side restores the
// reserved identity and the plaintext marker before Codex dispatches it.
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/tools/router.rs#L31-L55
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/tests/suite/subagent_notifications.rs#L1514-L1563
export const withPlaintextCollaboration: ResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'responses') return await run();
  const toolLists = toolInventories(ctx.payload);
  const collaborationCounts = toolLists.map(tools =>
    (tools ?? []).filter(tool => namespaceTool(tool)?.name === CLIENT_NAMESPACE).length);
  if (collaborationCounts.every(count => count === 0)) return await run();
  if (collaborationCounts.some(count => count > 1)) {
    throw new TypeError('Responses request carries multiple collaboration namespaces in one tool inventory');
  }

  const targetNamespace = upstreamNamespace(namespaceNames(ctx.payload));
  const clientPayload = ctx.payload;
  ctx.payload = {
    ...ctx.payload,
    tools: rewriteTools(ctx.payload.tools, CLIENT_NAMESPACE, targetNamespace, false),
    tool_choice: rewriteToolChoice(ctx.payload.tool_choice, CLIENT_NAMESPACE, targetNamespace),
    input: ctx.payload.input.map(item => requestItem(item, targetNamespace)),
  };

  let result;
  try {
    result = await run();
  } finally {
    ctx.payload = clientPayload;
  }
  if (result.type !== 'events') return result;
  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const event = clientEvent(frame.event, targetNamespace);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
