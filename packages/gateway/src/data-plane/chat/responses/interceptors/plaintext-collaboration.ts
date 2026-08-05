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

const CLIENT_NAMESPACE = 'collaboration';
const UPSTREAM_NAMESPACE_PREFIX = 'floway_collaboration_';
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

const namespaceNames = (payload: CanonicalResponsesPayload): Set<string> => {
  const names = new Set<string>();
  const visit = (tools: readonly ResponsesTool[] | null | undefined) => {
    for (const tool of tools ?? []) {
      if (tool.type === 'namespace' && typeof tool.name === 'string') names.add(tool.name);
    }
  };
  visit(payload.tools);
  for (const item of payload.input) {
    if (item.type === 'additional_tools') visit(item.tools);
    if (item.type === 'function_call' && item.namespace !== undefined) names.add(item.namespace);
  }
  return names;
};

const randomNamespace = (occupied: ReadonlySet<string>): string => {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  const rewritten: Record<string, unknown> = { ...toolChoice };
  if (rewritten.namespace === fromNamespace) rewritten.namespace = toNamespace;
  if (rewritten.type === 'namespace' && rewritten.name === fromNamespace) rewritten.name = toNamespace;
  if (Array.isArray(rewritten.tools)) {
    rewritten.tools = rewritten.tools.map(tool => {
      if (!isRecord(tool)) return tool;
      const entry = { ...tool };
      if (entry.namespace === fromNamespace) entry.namespace = toNamespace;
      if (entry.type === 'namespace' && entry.name === fromNamespace) entry.name = toNamespace;
      return entry;
    });
  }
  return rewritten as ResponsesToolChoice;
};

const requestItem = (item: ResponsesInputItem, upstreamNamespace: string): ResponsesInputItem => {
  if (item.type === 'additional_tools') {
    return {
      ...item,
      tools: rewriteTools(item.tools, CLIENT_NAMESPACE, upstreamNamespace, false) ?? [],
    };
  }
  if (item.type !== 'function_call' || item.namespace !== CLIENT_NAMESPACE) return item;
  const { encrypted_function_args: _plaintextMarker, ...rest } = item;
  return { ...rest, namespace: upstreamNamespace };
};

const clientItem = (item: ResponsesOutputItem, upstreamNamespace: string): ResponsesOutputItem => {
  if (item.type === 'additional_tools') {
    return {
      ...item,
      tools: rewriteTools(item.tools, upstreamNamespace, CLIENT_NAMESPACE, true) ?? [],
    };
  }
  if (item.type !== 'function_call' || item.namespace !== upstreamNamespace) return item;
  return {
    ...item,
    namespace: CLIENT_NAMESPACE,
    ...(MESSAGE_ACTIONS.has(item.name) ? { encrypted_function_args: [] } : {}),
  };
};

const clientResponse = (response: ResponsesResult, upstreamNamespace: string): ResponsesResult => ({
  ...response,
  output: response.output.map(item => clientItem(item, upstreamNamespace)),
  ...(response.tools !== undefined
    ? { tools: rewriteTools(response.tools, upstreamNamespace, CLIENT_NAMESPACE, true) ?? undefined }
    : {}),
  ...(response.tool_choice !== undefined
    ? { tool_choice: rewriteToolChoice(response.tool_choice, upstreamNamespace, CLIENT_NAMESPACE) }
    : {}),
});

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
  const toolLists = [
    ctx.payload.tools,
    ...ctx.payload.input.flatMap(item => item.type === 'additional_tools' ? [item.tools] : []),
  ];
  const collaborationCounts = toolLists.map(tools =>
    (tools ?? []).filter(tool => namespaceTool(tool)?.name === CLIENT_NAMESPACE).length);
  if (collaborationCounts.every(count => count === 0)) return await run();
  if (collaborationCounts.some(count => count > 1)) {
    throw new TypeError('Responses request carries multiple collaboration namespaces in one tool inventory');
  }

  const upstreamNamespace = randomNamespace(namespaceNames(ctx.payload));
  ctx.payload = {
    ...ctx.payload,
    tools: rewriteTools(ctx.payload.tools, CLIENT_NAMESPACE, upstreamNamespace, false),
    tool_choice: rewriteToolChoice(ctx.payload.tool_choice, CLIENT_NAMESPACE, upstreamNamespace),
    input: ctx.payload.input.map(item => requestItem(item, upstreamNamespace)),
  };

  const result = await run();
  if (result.type !== 'events') return result;
  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const event = clientEvent(frame.event, upstreamNamespace);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
