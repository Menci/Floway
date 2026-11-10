import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx, type OpenAIResponsesTool, type OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

export interface NamespaceToolNames {
  sourceToTarget: Map<string, string>;
  targetToSource: Map<string, CallableIdentity>;
  sourceTools: CanonicalOpenAIResponsesPayload['tools'];
  sourceToolChoice: CanonicalOpenAIResponsesPayload['tool_choice'];
  toolsChanged: boolean;
  toolChoiceChanged: boolean;
}

interface CallableIdentity {
  namespace: string;
  name: string;
  type: 'function_call' | 'custom_tool_call';
}

type ObjectToolChoice = Exclude<OpenAIResponsesToolChoice, string | null | undefined>;
type NamedToolChoice = Extract<ObjectToolChoice, { type: 'function' | 'custom' }>;

const isNamedToolChoice = (value: Record<string, unknown>): value is Record<string, unknown> & NamedToolChoice =>
  (value.type === 'function' || value.type === 'custom')
  && typeof value.name === 'string'
  && (value.namespace === undefined || typeof value.namespace === 'string');

export const restoreNamespaceOutputItem = (
  item: OpenAIResponsesOutputItemEx,
  names: Pick<NamespaceToolNames, 'targetToSource'>,
  status: 'in_progress' | 'completed',
): OpenAIResponsesOutputItemEx => {
  if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.namespace !== undefined) return item;
  const identity = names.targetToSource.get(item.name);
  if (identity === undefined) return item;
  if (item.type === 'function_call') {
    if (identity.type === 'function_call') return { ...item, name: identity.name, namespace: identity.namespace };
    const { type: _type, arguments: input, ...rest } = item;
    return { ...rest, type: 'custom_tool_call', name: identity.name, namespace: identity.namespace, input };
  }
  if (identity.type === 'custom_tool_call') return { ...item, name: identity.name, namespace: identity.namespace };
  const { type: _type, input: arguments_, ...rest } = item;
  return { ...rest, type: 'function_call', name: identity.name, namespace: identity.namespace, arguments: arguments_, status: item.status ?? status };
};

// Both translated targets require flat callable names. Reserve names from the
// full inventory and raw history before projecting declarations so an excluded
// historical call cannot acquire a different identity on a later turn.
// https://github.com/lidge-jun/opencodex/blob/e45692f8d8e4dedfb4e9b0217fc245080fb2fba8/src/responses/plaintext-v2-agent-messages.ts#L347-L427
export const flattenNamespaceTools = (payload: CanonicalOpenAIResponsesPayload): {
  payload: CanonicalOpenAIResponsesPayload;
  names: NamespaceToolNames;
  flattenInput: (input: readonly CanonicalOpenAIResponsesInputItem[]) => CanonicalOpenAIResponsesInputItem[];
} => {
  const inventories = [payload.tools ?? [], ...payload.input.flatMap(item =>
    item.type === 'additional_tools' || item.type === 'tool_search_output' ? [item.tools] : [])];
  const flatNames = new Set(inventories.flatMap(tools => tools.flatMap(tool =>
    tool.type === 'function' || tool.type === 'custom' ? [tool.name] : [])));
  for (const item of payload.input) {
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace === undefined) flatNames.add(item.name);
  }
  const reserved = new Set(flatNames);
  const names: NamespaceToolNames = {
    sourceToTarget: new Map(), targetToSource: new Map(),
    sourceTools: undefined, sourceToolChoice: undefined,
    toolsChanged: false, toolChoiceChanged: false,
  };
  const byNamespace = new Map<string, Array<{ type: 'function' | 'custom'; name: string }>>();
  const nextSuffixes = new Map<string, number>();
  const allocate = (namespace: string, name: string, kind: 'function' | 'custom'): string => {
    const type = kind === 'function' ? 'function_call' : 'custom_tool_call';
    const key = `${namespace}.${name}`;
    const existing = names.sourceToTarget.get(key);
    if (existing !== undefined) {
      const identity = names.targetToSource.get(existing)!;
      if (identity.namespace !== namespace || identity.name !== name || identity.type !== type) {
        throw new TranslatorInputError(`Cannot translate ambiguous namespace tool '${key}'.`);
      }
      return existing;
    }
    // OpenAI Chat Completions limits function names to 64 ASCII characters.
    // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
    // Bound sanitization work even for a long shared namespace.
    const scope = `${namespace.slice(0, 64)}_`.slice(0, 64);
    const base = `${scope}${name.slice(0, 64 - scope.length)}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    for (let suffix = 1; ; suffix++) {
      const ending = suffix === 1 ? '' : `_${suffix}`;
      const prefix = base.slice(0, 64 - ending.length);
      if (suffix > 1) {
        // Share cursors only when both the truncated prefix and suffix width match.
        const key = `${ending.length}:${prefix}`;
        const next = nextSuffixes.get(key);
        if (next !== undefined && next > suffix) { suffix = next - 1; continue; }
        nextSuffixes.set(key, suffix + 1);
      }
      const candidate = `${prefix}${ending}`;
      if (reserved.has(candidate)) continue;
      reserved.add(candidate);
      names.sourceToTarget.set(key, candidate);
      names.targetToSource.set(candidate, { namespace, name, type });
      return candidate;
    }
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
        tools.push({
          ...child, name,
          ...(tool.description ? { description: child.description ? `${tool.description}\n\n${child.description}` : tool.description } : {}),
        });
      }
    }
  }
  const flattenInput = (input: readonly CanonicalOpenAIResponsesInputItem[]) => input.flatMap<CanonicalOpenAIResponsesInputItem>(item => {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') return [];
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return [item];
    if (item.namespace === undefined) return [item];
    const { namespace, ...rest } = item;
    return [{ ...rest, name: allocate(namespace, item.name, item.type === 'function_call' ? 'function' : 'custom') }];
  });
  const selector = (choice: ObjectToolChoice): ObjectToolChoice => {
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
      const original = choice;
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
          if (tool.type !== 'function' && tool.type !== 'custom') return [tool];
          if (!isNamedToolChoice(tool)) throw new TranslatorInputError('Cannot translate malformed allowed_tools selector.');
          const selected = selector(tool);
          return selected === tool ? [tool] : [{ ...selected }];
        }),
      };
      if (choice.tools.length === original.tools.length && choice.tools.every((tool, index) => tool === original.tools[index])) choice = original;
    } else choice = selector(choice);
  }
  names.toolsChanged = inventories.length > 1 || payload.tools?.some(tool => tool.type === 'namespace') === true;
  names.toolChoiceChanged = choice !== payload.tool_choice;
  names.sourceTools = names.toolsChanged ? payload.tools : undefined;
  names.sourceToolChoice = names.toolChoiceChanged ? payload.tool_choice : undefined;
  return { payload: { ...payload, ...(payload.tools == null && inventories.length === 1 ? {} : { tools }), ...(choice === undefined ? {} : { tool_choice: choice }) }, names, flattenInput };
};

export const restoreNamespaceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  names: NamespaceToolNames,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const { sourceTools, sourceToolChoice, toolsChanged, toolChoiceChanged } = names;
  const items = new Map<string, Pick<CallableIdentity, 'name' | 'type'>>();
  for await (const frame of frames) {
    if (frame.type !== 'event') { yield frame; continue; }
    const event = frame.event;
    const identity = 'item_id' in event ? items.get(event.item_id) : undefined;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = restoreNamespaceOutputItem(event.item, names, event.type === 'response.output_item.added' ? 'in_progress' : 'completed');
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.id === 'string') items.set(item.id, { name: item.name, type: item.type });
      yield item === event.item ? frame : { ...frame, event: { ...event, item } };
    } else if (event.type === 'response.function_call_arguments.delta' && identity?.type === 'custom_tool_call') {
      yield { ...frame, event: { ...event, type: 'response.custom_tool_call_input.delta' } };
    } else if (event.type === 'response.function_call_arguments.done' && identity !== undefined) {
      // Function arguments.done requires a bare name, not a namespace. Custom
      // input.done has neither field; changing families must not leak a wire name.
      // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts
      if (identity.type === 'function_call') {
        if ('name' in event && event.name === identity.name) yield frame;
        else {
          const restoredEvent: OpenAIResponsesStreamEventEx = { ...event, name: identity.name };
          yield { ...frame, event: restoredEvent };
        }
      } else {
        const { arguments: input, name: _name, ...rest } = event;
        yield { ...frame, event: { ...rest, type: 'response.custom_tool_call_input.done', input } };
      }
    } else if (event.type === 'response.custom_tool_call_input.delta' && identity?.type === 'function_call') {
      yield { ...frame, event: { ...event, type: 'response.function_call_arguments.delta' } };
    } else if (event.type === 'response.custom_tool_call_input.done' && identity?.type === 'function_call') {
      const { input: args, ...rest } = event;
      const restoredEvent: OpenAIResponsesStreamEventEx = { ...rest, type: 'response.function_call_arguments.done', arguments: args, name: identity.name };
      yield { ...frame, event: restoredEvent };
    } else if ('response' in event && Array.isArray(event.response?.output)) {
      const output = event.response.output.map(item => restoreNamespaceOutputItem(item, names, isOpenAIResponsesTerminalEvent(event) ? 'completed' : 'in_progress'));
      const outputChanged = output.some((item, index) => item !== event.response.output[index]);
      const restoreTools = toolsChanged && event.response.tools !== undefined && event.response.tools !== sourceTools;
      const restoreChoice = toolChoiceChanged && event.response.tool_choice !== undefined && event.response.tool_choice !== sourceToolChoice;
      if (!outputChanged && !restoreTools && !restoreChoice) {
        yield frame;
        continue;
      }
      const response: OpenAIResponsesResultEx = {
        ...event.response,
        output: outputChanged ? output : event.response.output,
        // Preserve absent echoes; only undo fields actually stated by the
        // translated result. The outer shim must not observe invented tools.
        ...(restoreChoice ? { tool_choice: sourceToolChoice } : {}),
      };
      if (restoreTools) {
        if (sourceTools == null) delete response.tools;
        else response.tools = sourceTools;
      }
      const restoredEvent: OpenAIResponsesStreamEventEx = { ...event, response };
      yield { ...frame, event: restoredEvent };
    } else yield frame;
  }
};
