import { TranslatorInputError } from '../../translator-input-error.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesOutputItem, OpenAIResponsesStreamEvent, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

export interface NamespaceToolNames {
  sourceToTarget: Map<string, string>;
  targetToSource: Map<string, { namespace: string; name: string }>;
}

// Both translated targets require flat callable names. Build the map from the
// full inventory and replay before selecting allowed tools so an excluded
// historical call cannot acquire a different identity on a later turn.
// https://github.com/lidge-jun/opencodex/blob/e45692f8d8e4dedfb4e9b0217fc245080fb2fba8/src/responses/plaintext-v2-agent-messages.ts#L347-L427
export const flattenNamespaceTools = (payload: CanonicalOpenAIResponsesPayload): {
  payload: CanonicalOpenAIResponsesPayload;
  names: NamespaceToolNames;
} => {
  const inventories = [payload.tools ?? [], ...payload.input.flatMap(item =>
    item.type === 'additional_tools' || item.type === 'tool_search_output' ? [item.tools] : [])];
  const flatNames = new Set(inventories.flatMap(tools => tools.flatMap(tool =>
    tool.type === 'function' || tool.type === 'custom' ? [tool.name] : [])));
  for (const item of payload.input) {
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace === undefined) flatNames.add(item.name);
  }
  const reserved = new Set(flatNames);
  const names: NamespaceToolNames = { sourceToTarget: new Map(), targetToSource: new Map() };
  const byNamespace = new Map<string, Array<{ type: 'function' | 'custom'; name: string }>>();
  const kinds = new Map<string, string>();
  const allocate = (namespace: string, name: string, kind: string): string => {
    const key = `${namespace}.${name}`;
    const existing = names.sourceToTarget.get(key);
    if (existing !== undefined) {
      const identity = names.targetToSource.get(existing)!;
      if (identity.namespace !== namespace || identity.name !== name || kinds.get(existing) !== kind) {
        throw new TranslatorInputError(`Cannot translate ambiguous namespace tool '${key}'.`);
      }
      return existing;
    }
    // OpenAI Chat Completions limits function names to 64 ASCII characters.
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
    const base = `${namespace}_${name}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    for (let suffix = 1; suffix <= 1000; suffix++) {
      const ending = suffix === 1 ? '' : `_${suffix}`;
      const candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
      if (reserved.has(candidate)) continue;
      reserved.add(candidate);
      kinds.set(candidate, kind);
      names.sourceToTarget.set(key, candidate);
      names.targetToSource.set(candidate, { namespace, name });
      return candidate;
    }
    throw new TranslatorInputError(`Cannot allocate a flat tool name for '${key}'.`);
  };
  const tools: OpenAIResponsesTool[] = [];
  for (const inventory of inventories) {
    for (const tool of inventory) {
      if (tool.type !== 'namespace') {
        tools.push(tool);
        continue;
      }
      const children = byNamespace.get(tool.name) ?? [];
      byNamespace.set(tool.name, children);
      for (const child of tool.tools) {
        if (child.type !== 'function' && child.type !== 'custom') {
          throw new TranslatorInputError(`Cannot translate non-callable child in namespace '${tool.name}'.`);
        }
        const name = allocate(tool.name, child.name, child.type);
        children.push({ type: child.type, name });
        tools.push({ ...child, name });
      }
    }
  }
  const input = payload.input.flatMap<OpenAIResponsesInputItem>(item => {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') return [];
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return [item];
    if (item.namespace === undefined) return [item];
    const { namespace, ...rest } = item;
    return [{ ...rest, name: allocate(namespace, item.name, item.type === 'function_call' ? 'function' : 'custom') }];
  });
  const selector = (choice: Exclude<OpenAIResponsesToolChoice, string | null | undefined>): Exclude<OpenAIResponsesToolChoice, string | null | undefined> => {
    if (choice.type !== 'function' && choice.type !== 'custom') return choice;
    const namespace = choice.namespace;
    const key = namespace === undefined ? choice.name : `${namespace}.${choice.name}`;
    if (namespace === undefined && flatNames.has(choice.name)) return choice;
    if (namespace !== undefined && !byNamespace.get(namespace)?.some(child => child.type === choice.type && names.targetToSource.get(child.name)?.name === choice.name)) {
      throw new TranslatorInputError(`Cannot translate tool_choice / allowed_tools selector for undeclared namespace tool '${key}'.`);
    }
    const qualified = namespace === undefined
      ? [...names.targetToSource].filter(([, identity]) => `${identity.namespace}.${identity.name}` === key || `${identity.namespace}__${identity.name}` === key)
      : [];
    if (qualified.length > 1) throw new TranslatorInputError(`Cannot select ambiguous qualified tool '${key}'.`);
    const name = namespace === undefined ? qualified[0]?.[0] : names.sourceToTarget.get(key);
    if (name === undefined) return choice;
    const { namespace: _namespace, ...rest } = choice;
    return { ...rest, name };
  };
  let choice = payload.tool_choice;
  if (typeof choice === 'object' && choice !== null) {
    if (choice.type === 'allowed_tools' && Array.isArray(choice.tools)) {
      choice = {
        ...choice,
        tools: choice.tools.flatMap(tool => {
          if (typeof tool !== 'object' || tool === null) throw new TranslatorInputError('Cannot translate malformed allowed_tools selector.');
          if (tool.type === 'namespace') {
            const children = typeof tool.name === 'string' ? byNamespace.get(tool.name) : undefined;
            if (children === undefined) throw new TranslatorInputError(`Cannot select undeclared namespace '${String(tool.name)}'.`);
            if (Object.keys(tool).some(key => key !== 'type' && key !== 'name')) throw new TranslatorInputError('Cannot translate namespace selector extensions.');
            return children;
          }
          return [selector(tool as Exclude<OpenAIResponsesToolChoice, string | null | undefined>) as Record<string, unknown>];
        }),
      };
    } else choice = selector(choice);
  }
  return { payload: { ...payload, input, tools: tools.length > 0 ? tools : payload.tools, tool_choice: choice }, names };
};

export const restoreNamespaceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  names: ReadonlyMap<string, { namespace: string; name: string }>,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const restoreItem = (item: OpenAIResponsesOutputItem): OpenAIResponsesOutputItem => {
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
    const source = names.get(item.name);
    return source === undefined ? item : { ...item, ...source };
  };
  for await (const frame of frames) {
    if (frame.type !== 'event') { yield frame; continue; }
    const event = frame.event;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      yield eventFrame({ ...event, item: restoreItem(event.item) });
    } else if (event.type === 'response.created' || event.type === 'response.queued' || event.type === 'response.in_progress'
      || event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      yield eventFrame({ ...event, response: { ...event.response, output: event.response.output.map(restoreItem) } });
    } else yield frame;
  }
};
