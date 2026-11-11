import type { ResolvedTurn } from './segments.ts';
import { irInputToolsForChoice } from '../ir/input/select-tools.ts';
import type { IRInputRequestHeader, IRInputTool, IRInputToolChoice, IRInputToolSelector, IRInputTurn } from '../ir/input/types.ts';
import { TranslatorInputError } from '../types.ts';

/** What a target that writes flat names records for the reader of its answer. */
export interface FlatCallContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly flatIdentities: ReadonlyMap<string, { readonly namespace?: string; readonly name: string }>;
}

const customNamesOf = (request: IRInputRequestHeader): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

interface CallableIdentity {
  readonly type: 'function' | 'custom';
  readonly namespace?: string;
  readonly name: string;
}

const callableKey = ({ type, namespace, name }: CallableIdentity): string => JSON.stringify([type, namespace, name]);

const flatNamesOf = (
  tools: readonly IRInputTool[],
  turns: readonly IRInputTurn[],
): { readonly flat: ReadonlyMap<string, string>; readonly identities: Map<string, { readonly namespace?: string; readonly name: string }> } => {
  const calls = turns.flatMap(turn => turn.items.flatMap(item =>
    item.type === 'function_call' || item.type === 'custom_tool_call'
      ? [{ type: item.type === 'function_call' ? 'function' as const : 'custom' as const, namespace: item.namespace, name: item.name }]
      : []));
  const callables = [...tools, ...calls];
  const reserved = new Set(callables.flatMap(callable => callable.namespace === undefined ? [callable.name] : []));
  const flat = assignFlatNames(callables, reserved);
  const identities = new Map<string, { readonly namespace?: string; readonly name: string }>();
  for (const callable of callables) {
    const flatName = flat.get(callableKey(callable))!;
    if (callable.namespace !== undefined || flatName !== callable.name) {
      identities.set(flatName, { name: callable.name, ...(callable.namespace === undefined ? {} : { namespace: callable.namespace }) });
    }
  }
  return { flat, identities };
};

/**
 * States this target's request and conversation with flat callable names.
 *
 * Declarations and historical calls share one allocation keyed by kind, group,
 * and name. Bare names stay unchanged unless two callable kinds share one. The
 * grouping itself is dropped, because this wire has nowhere to state it. What the
 * returned context carries is what the same spelling decided: which
 * declarations were freeform, and which identity each allocated name came from.
 */
export const flattenRequestNames = <Restored>(
  request: IRInputRequestHeader,
  inputTurns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
): { readonly request: IRInputRequestHeader; readonly turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[]; readonly context: FlatCallContext } => {
  const irTurns = inputTurns.flatMap(turn => turn.kind === 'resolved' ? [] : [turn]);
  const { flat, identities: flatIdentities } = flatNamesOf(request.tools ?? [], irTurns);

  const nameOf = (callable: CallableIdentity): string => {
    const flatName = flat.get(callableKey(callable));
    if (flatName !== undefined) return flatName;
    if (callable.namespace === undefined) return callable.name;
    throw new TranslatorInputError(`Cannot translate a selector for undeclared grouped tool '${callable.namespace}.${callable.name}'.`);
  };
  const flattenChoice = (choice: IRInputToolChoice): IRInputToolChoice => {
    if (typeof choice === 'string') return choice;
    if (choice.type === 'allowed_tools') return { ...choice, tools: choice.tools.map(flattenSelection) };
    return flattenSelection(choice);
  };
  const flattenSelection = (selection: IRInputToolSelector): IRInputToolSelector => {
    const { namespace: _namespace, ...rest } = selection;
    return { ...rest, name: nameOf(selection) };
  };
  const toolChoice = request.tool_choice === undefined ? undefined : flattenChoice(request.tool_choice);
  const flattenTool = (tool: IRInputTool): IRInputTool => {
    const { namespace: _namespace, ...rest } = tool;
    return { ...rest, name: nameOf(tool) };
  };
  const flattenedRequest: IRInputRequestHeader = {
    ...request,
    ...(request.tools === undefined ? {} : { tools: request.tools.map(flattenTool) }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
  return {
    request: flattenedRequest,
    context: { customToolNames: customNamesOf(flattenedRequest), flatIdentities },
    turns: inputTurns.map((turn): IRInputTurn | ResolvedTurn<Restored> => {
      if (turn.kind === 'resolved') return turn;
      if (turn.kind === 'assistant') {
        return {
          kind: 'assistant',
          items: turn.items.map(item => item.type === 'function_call' || item.type === 'custom_tool_call'
            ? { ...item, name: nameOf({ type: item.type === 'function_call' ? 'function' : 'custom', namespace: item.namespace, name: item.name }) }
            : item),
        };
      }
      return turn;
    }),
  };
};

/**
 * Assigns names independently of tool choice. Both callable kinds become function
 * declarations on these targets, so even ungrouped names may need a suffix.
 * Original bare names are reserved before allocation to keep aliases from
 * taking a later declaration's own name.
 *
 * Grouped names are limited to Chat's 64 ASCII characters; collision suffixes
 * follow allocation order across the complete declarations and history.
 * https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
 */
const assignFlatNames = (
  callables: readonly CallableIdentity[],
  reserved: ReadonlySet<string>,
): Map<string, string> => {
  const taken = new Set(reserved);
  const nextSuffixes = new Map<string, number>();
  const assigned = new Map<string, string>();
  // Dotted selectors cannot distinguish two pairs with the same qualified spelling.
  const assignedPairs = new Map<string, { readonly namespace: string; readonly name: string }>();
  const bareNames = new Set<string>();
  for (const callable of callables) {
    const { namespace, name } = callable;
    const key = callableKey(callable);
    if (assigned.has(key)) continue;
    if (namespace === undefined && !bareNames.has(name)) {
      bareNames.add(name);
      assigned.set(key, name);
      continue;
    }
    if (namespace !== undefined) {
      const dotted = `${namespace}.${name}`;
      const prior = assignedPairs.get(dotted);
      if (prior !== undefined && (prior.namespace !== namespace || prior.name !== name)) {
        throw new TranslatorInputError(`Cannot translate ambiguous grouped callables both spelling '${dotted}'.`);
      }
      assignedPairs.set(dotted, { namespace, name });
    }
    const scope = namespace === undefined ? '' : `${namespace.slice(0, 64)}_`.slice(0, 64);
    const base = namespace === undefined ? name : `${scope}${name.slice(0, 64 - scope.length)}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    for (let suffix = 1; ; suffix++) {
      const ending = suffix === 1 ? '' : `_${suffix}`;
      const prefix = base.slice(0, 64 - ending.length);
      if (suffix > 1) {
        // Share cursors only when both the truncated prefix and suffix width match.
        const cursor = `${ending.length}:${prefix}`;
        const next = nextSuffixes.get(cursor);
        if (next !== undefined && next > suffix) { suffix = next - 1; continue; }
        nextSuffixes.set(cursor, suffix + 1);
      }
      const candidate = `${prefix}${ending}`;
      if (taken.has(candidate)) continue;
      taken.add(candidate);
      assigned.set(key, candidate);
      break;
    }
  }
  return assigned;
};
