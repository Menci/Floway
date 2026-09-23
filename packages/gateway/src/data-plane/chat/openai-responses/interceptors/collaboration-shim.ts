import type { OpenAIResponsesInterceptor } from './types.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import {
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesInputItem,
  type OpenAIResponsesOutputItem,
  type OpenAIResponsesResult,
  type OpenAIResponsesStreamEvent,
  type OpenAIResponsesTool,
  type OpenAIResponsesToolChoice,
} from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

const CLIENT_NAMESPACE = 'collaboration';
// Shared ordinary namespace spelling used by deployed Codex gateways.
// https://github.com/lidge-jun/opencodex/blob/e45692f8d8e4dedfb4e9b0217fc245080fb2fba8/src/responses/plaintext-v2-agent-messages.ts#L1-L6
const UPSTREAM_NAMESPACE = 'collaboration-optimize';
// Codex dispatches these message actions locally when the marker is empty.
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/tools/router.rs#L31-L55
const MESSAGE_ACTIONS = new Set(['spawn_agent', 'send_message', 'followup_task']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toolInventories = (payload: CanonicalOpenAIResponsesPayload): Array<readonly OpenAIResponsesTool[] | null | undefined> => [
  payload.tools,
  ...payload.input.flatMap(item =>
    item.type === 'additional_tools' || item.type === 'tool_search_output' ? [item.tools] : []),
];

export const hasCollaborationNamespace = (payload: CanonicalOpenAIResponsesPayload): boolean =>
  toolInventories(payload).some(tools =>
    (tools ?? []).some(tool => tool.type === 'namespace' && tool.name === CLIENT_NAMESPACE))
  || payload.input.some(item => (item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace === CLIENT_NAMESPACE);

const namespaceNames = (payload: CanonicalOpenAIResponsesPayload): Set<string> => {
  const names = new Set<string>();
  const reserve = (value: object) => {
    const { name, namespace } = value as { name?: unknown; namespace?: unknown };
    if (typeof namespace === 'string') names.add(namespace);
    if (typeof name === 'string') {
      names.add(name);
      names.add(name.split(/[.]|__/)[0]);
    }
  };
  for (const tools of toolInventories(payload)) {
    for (const tool of tools ?? []) {
      reserve(tool);
      if (tool.type === 'namespace') for (const child of tool.tools) reserve(child);
    }
  }
  for (const item of payload.input) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') reserve(item);
  }
  const choice = payload.tool_choice;
  if (typeof choice === 'object' && choice !== null) {
    reserve(choice);
    if (choice.type === 'allowed_tools') for (const tool of choice.tools) reserve(tool);
  }
  return names;
};

const upstreamNamespace = (occupied: ReadonlySet<string>): string => {
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const candidate = suffix === 1 ? UPSTREAM_NAMESPACE : `${UPSTREAM_NAMESPACE}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error('Unable to resolve a free collaboration namespace within 1000 attempts');
};

const stripMessageEncryption = <T extends OpenAIResponsesTool>(tool: T): T => {
  if (tool.type !== 'function' || !MESSAGE_ACTIONS.has(tool.name) || !isRecord(tool.parameters)) return tool;
  const properties = tool.parameters.properties;
  if (!isRecord(properties) || !isRecord(properties.message)) return tool;
  const message = { ...properties.message };
  delete message.encrypted;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...properties, message },
    },
  };
};

const rewriteTools = (
  tools: readonly OpenAIResponsesTool[],
  fromNamespace: string,
  toNamespace: string,
): OpenAIResponsesTool[] => {
  return tools.map(tool => {
    if (tool.type !== 'namespace' || tool.name !== fromNamespace) return tool;
    return {
      ...tool,
      name: toNamespace,
      ...(fromNamespace === CLIENT_NAMESPACE ? { tools: tool.tools.map(stripMessageEncryption) } : {}),
    };
  });
};

const rewriteIdentity = <T extends { namespace?: unknown; name?: unknown }>(
  value: T, from: string, to: string, names: ReadonlySet<string>, flatNames: ReadonlySet<string>,
): T => {
  if (value.namespace != null && value.namespace !== from) return value;
  if (value.namespace === from && typeof value.name === 'string' && names.has(value.name)) return { ...value, namespace: to };
  if (typeof value.name !== 'string' || (value.namespace == null && flatNames.has(value.name))) return value;
  for (const separator of ['.', '__']) {
    const prefix = `${from}${separator}`;
    if (value.name.startsWith(prefix) && names.has(value.name.slice(prefix.length))) {
      return { ...value, namespace: to, name: value.name.slice(prefix.length) };
    }
  }
  return value.namespace === from ? { ...value, namespace: to } : value;
};

const rewriteToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
  fromNamespace: string,
  toNamespace: string,
  names: ReadonlySet<string>,
  flatNames: ReadonlySet<string>,
): OpenAIResponsesToolChoice | null | undefined => {
  if (!isRecord(toolChoice)) return toolChoice;
  const rewrite = (value: Record<string, unknown>): Record<string, unknown> => {
    if (value.type === 'namespace' && value.name === fromNamespace) return { ...value, name: toNamespace };
    if (value.type !== 'function' && value.type !== 'custom') return value;
    // A qualified selector stays qualified, preserving its original wire shape.
    const identity = rewriteIdentity(value, fromNamespace, toNamespace, names, flatNames);
    if (identity !== value && value.namespace === undefined && typeof value.name === 'string') {
      const separator = value.name.startsWith(`${fromNamespace}__`) ? '__' : '.';
      const { namespace: _namespace, ...rest } = identity;
      return { ...rest, name: `${toNamespace}${separator}${String(identity.name)}` };
    }
    return identity;
  };
  const rewritten = rewrite(toolChoice);
  return (Array.isArray(rewritten.tools)
    ? { ...rewritten, tools: rewritten.tools.map(tool => isRecord(tool) ? rewrite(tool) : tool) }
    : rewritten) as OpenAIResponsesToolChoice;
};

const requestItem = (item: OpenAIResponsesInputItem, upstreamNamespace: string, names: ReadonlySet<string>, flatNames: ReadonlySet<string>): OpenAIResponsesInputItem => {
  if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
    return {
      ...item,
      tools: rewriteTools(item.tools, CLIENT_NAMESPACE, upstreamNamespace),
    };
  }
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
  const projected = rewriteIdentity(item, CLIENT_NAMESPACE, upstreamNamespace, names, flatNames);
  if (projected === item) return item;
  if (projected.type === 'custom_tool_call') return projected;
  item = projected;
  if (!MESSAGE_ACTIONS.has(item.name)) return item;
  // Codex removes this marker from replay for providers not named exactly
  // `OpenAI`, including Floway. Absence must therefore remain the plaintext
  // replay form; explicit null/non-empty values still prove encrypted mode.
  // https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/client.rs#L848-L860
  if (
    item.encrypted_function_args !== undefined
    && (!Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length > 0)
  ) {
    throw new TypeError(`Cannot project encrypted collaboration history '${item.name}' onto a plaintext upstream`);
  }
  const { encrypted_function_args: _plaintextMarker, ...rest } = item;
  return { ...rest, namespace: upstreamNamespace };
};

const clientItem = (item: OpenAIResponsesOutputItem, upstreamNamespace: string, names: ReadonlySet<string>): OpenAIResponsesOutputItem => {
  if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
    return {
      ...item,
      tools: rewriteTools(item.tools, upstreamNamespace, CLIENT_NAMESPACE),
    };
  }
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
  const projected = rewriteIdentity(item, upstreamNamespace, CLIENT_NAMESPACE, names, new Set());
  if (projected === item) return item;
  if (projected.type === 'custom_tool_call') return projected;
  item = projected;
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

const clientResponse = (response: OpenAIResponsesResult, upstreamNamespace: string, names: ReadonlySet<string>): OpenAIResponsesResult => {
  const record = response as OpenAIResponsesResult & { tools?: OpenAIResponsesTool[] | null };
  return {
    ...response,
    output: response.output.map(item => clientItem(item, upstreamNamespace, names)),
    ...(Object.hasOwn(record, 'tools')
      ? { tools: record.tools == null ? record.tools : rewriteTools(record.tools, upstreamNamespace, CLIENT_NAMESPACE) }
      : {}),
    ...(response.tool_choice !== undefined
      ? { tool_choice: rewriteToolChoice(response.tool_choice, upstreamNamespace, CLIENT_NAMESPACE, names, new Set()) }
      : {}),
  } as OpenAIResponsesResult;
};

// Sparse events identify a call through any of these coordinates. Binding all
// coordinates prevents later snapshots or argument completion from changing
// the dispatch identity established by output_item.added.
// https://github.com/lidge-jun/opencodex/blob/e45692f8d8e4dedfb4e9b0217fc245080fb2fba8/src/responses/plaintext-v2-agent-messages.ts#L827-L902
const createClientEventRestorer = (upstreamNamespace: string, names: ReadonlySet<string>) => {
  type Binding = { name?: string; namespace?: string; encrypted: boolean; keys: Set<string> };
  const bindings = new Map<string, Binding>();
  // `function_call` items and `arguments.done` completions carry a dispatch
  // identity; a sparse `arguments.delta` does not. Upstream may echo a call as
  // a flat `namespace__name` in a delta's `name` while the preceding
  // `output_item.added` used separated `namespace`/`name`, so a delta's
  // `name`/`namespace` must never reach the conflict check below — it only
  // contributes encrypted evidence and correlation keys.
  // https://github.com/lidge-jun/opencodex/blob/e45692f8d8e4dedfb4e9b0217fc245080fb2fba8/src/responses/plaintext-v2-agent-messages.ts#L827-L902
  const IDENTITY_TYPES = new Set(['function_call', 'response.function_call_arguments.done']);
  const bind = (value: Record<string, unknown>, outputIndex?: number): Record<string, unknown> => {
    value = rewriteIdentity(value, upstreamNamespace, upstreamNamespace, names, new Set());
    const keys = [
      typeof value.id === 'string' ? `id:${value.id}` : undefined,
      typeof value.item_id === 'string' ? `id:${value.item_id}` : undefined,
      typeof value.call_id === 'string' ? `call:${value.call_id}` : undefined,
      outputIndex === undefined ? undefined : `index:${outputIndex}`,
    ].filter((key): key is string => key !== undefined);
    const groups = [...new Set(keys.flatMap(key => {
      const prior = bindings.get(key);
      return prior === undefined ? [] : [prior];
    }))];
    const marker = value.encrypted_function_args;
    const binding: Binding = {
      keys: new Set(keys),
      encrypted: (marker !== undefined && (!Array.isArray(marker) || marker.length > 0)) || groups.some(group => group.encrypted),
    };
    const isIdentityCarrier = typeof value.type === 'string' && IDENTITY_TYPES.has(value.type);
    // An upstream may echo the same call with a flat `namespace__name` (or
    // `namespace.name`) in `name` while a prior event used separated
    // `namespace`/`name`. Normalize every candidate to a separated pair before
    // the conflict check: a flat name with no explicit namespace contributes
    // its own prefix as the namespace, so both spellings of the same call
    // compare equal regardless of event order. The rightmost separator splits
    // off the tool name so a multi-segment namespace such as `mcp__cua_repl`
    // survives intact (`mcp__cua_repl__js` → `mcp__cua_repl` + `js`).
    const normalize = (identity: Record<string, unknown>): { namespace?: unknown; name?: unknown } => {
      const name = identity.name;
      if (typeof name !== 'string') return identity;
      if (identity.namespace !== undefined && identity.namespace !== null) return identity;
      for (const separator of ['__', '.']) {
        const at = name.lastIndexOf(separator);
        if (at > 0) return { namespace: name.slice(0, at), name: name.slice(at + separator.length) };
      }
      return identity;
    };
    for (const identity of [...groups, ...(isIdentityCarrier ? [value] : [])]) {
      const candidate = normalize(identity);
      for (const field of ['namespace', 'name'] as const) {
        const next = candidate[field];
        if (next === undefined) continue;
        if (typeof next !== 'string' || (binding[field] !== undefined && binding[field] !== next)) {
          throw new TypeError('Conflicting collaboration stream call identity');
        }
        binding[field] = next;
      }
    }
    for (const group of groups) for (const key of group.keys) binding.keys.add(key);
    for (const key of binding.keys) bindings.set(key, binding);
    if (binding.namespace !== upstreamNamespace) return value;
    if (binding.name !== undefined && MESSAGE_ACTIONS.has(binding.name)) {
      if (binding.encrypted) {
        throw new TypeError(`Plaintext collaboration upstream returned encrypted arguments for '${binding.name}'`);
      }
    }
    return {
      ...value,
      ...(value.namespace !== undefined ? { namespace: upstreamNamespace } : {}),
      ...(value.type === 'function_call' ? { namespace: upstreamNamespace, name: binding.name } : {}),
    };
  };
  return (event: OpenAIResponsesStreamEvent): OpenAIResponsesStreamEvent => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = event.item.type === 'function_call'
        ? bind(event.item as unknown as Record<string, unknown>, event.output_index) as unknown as OpenAIResponsesOutputItem
        : event.item;
      return { ...event, item: clientItem(item, upstreamNamespace, names) };
    }
    if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
      const record = event as unknown as Record<string, unknown>;
      const bound = bind(record, event.output_index);
      const identity = bindings.get(`id:${event.item_id}`) ?? bindings.get(`index:${event.output_index}`);
      if (identity?.namespace !== upstreamNamespace) return event;
      return {
        ...bound,
        ...(bound.namespace !== undefined ? { namespace: CLIENT_NAMESPACE } : {}),
        ...(event.type === 'response.function_call_arguments.done' && identity.name !== undefined && MESSAGE_ACTIONS.has(identity.name)
          ? { encrypted_function_args: [] } : {}),
      } as unknown as OpenAIResponsesStreamEvent;
    }
    if (event.type === 'response.queued' || event.type === 'response.created' || event.type === 'response.in_progress'
      || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const response = {
        ...event.response,
        output: event.response.output.map((item, index) => item.type === 'function_call'
          ? bind(item as unknown as Record<string, unknown>, index) as unknown as OpenAIResponsesOutputItem : item),
      };
      return { ...event, response: clientResponse(response, upstreamNamespace, names) };
    }
    return event;
  };
};

// Copilot reserves the exact `collaboration` namespace schema used by Codex,
// while Codex explicitly supports plaintext collaboration calls marked by an
// empty `encrypted_function_args` list. A request-scoped ordinary namespace
// lets the upstream produce plaintext; the client-facing side restores the
// reserved identity and the plaintext marker before Codex dispatches it.
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/src/tools/router.rs#L31-L55
// https://github.com/openai/codex/blob/c4f42d161ae44a8d696ee9fb595709661979d187/codex-rs/core/tests/suite/subagent_notifications.rs#L1514-L1563
// TODO: Stateful Responses must hydrate before alias allocation and persist
// client-facing snapshots with the same full-history mapping on continuation.
export const withOpenAIResponsesCollaborationShim: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('openai-responses-collaboration-shim')) return await run();
  const toolLists = toolInventories(ctx.payload);
  if (!hasCollaborationNamespace(ctx.payload)) return await run();

  const names = new Set<string>();
  const flatNames = new Set<string>();
  for (const tools of toolLists) for (const tool of tools ?? []) {
    if (tool.type === 'namespace' && tool.name === CLIENT_NAMESPACE) {
      for (const child of tool.tools) names.add(child.name);
    } else if (tool.type === 'function' || tool.type === 'custom') flatNames.add(tool.name);
  }
  for (const item of ctx.payload.input) {
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace === CLIENT_NAMESPACE) names.add(item.name);
  }
  const targetNamespace = upstreamNamespace(namespaceNames(ctx.payload));
  ctx.payload = {
    ...ctx.payload,
    tools: ctx.payload.tools == null ? ctx.payload.tools : rewriteTools(ctx.payload.tools, CLIENT_NAMESPACE, targetNamespace),
    tool_choice: rewriteToolChoice(ctx.payload.tool_choice, CLIENT_NAMESPACE, targetNamespace, names, flatNames),
    input: ctx.payload.input.map(item => requestItem(item, targetNamespace, names, flatNames)),
  };

  const restoreEvent = createClientEventRestorer(targetNamespace, names);
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
        const event = restoreEvent(frame.event);
        yield event === frame.event ? frame : eventFrame(event);
      }
    })(),
  };
};
