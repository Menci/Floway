import type { RestoredAssistantTurn } from './segments.ts';
import type { IRInputRequestHeader, IRInputTool, IRInputToolChoice, IRInputToolSelector, IRInputTurn } from '../ir/input/types.ts';
import { TranslateInputException } from '../types.ts';

/** What a target that writes wireNames names records for the reader of its answer. */
export interface ToolNameContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly originalToolNames: ReadonlyMap<string, Pick<IRInputToolSelector, 'namespace' | 'name'>>;
}

const customNamesOf = (request: IRInputRequestHeader): ReadonlySet<string> =>
  new Set((request.tools ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

const callableKey = ({ type, namespace, name }: IRInputToolSelector): string => JSON.stringify([type, namespace, name]);

const allocateCallableNames = (
  tools: readonly IRInputTool[],
  turns: readonly IRInputTurn[],
): { readonly wireNames: ReadonlyMap<string, string>; readonly identities: Map<string, Pick<IRInputToolSelector, 'namespace' | 'name'>> } => {
  const calls = turns.flatMap(turn => turn.items.flatMap(item =>
    item.type === 'function_call' || item.type === 'custom_tool_call'
      ? [{ type: item.type === 'function_call' ? 'function' as const : 'custom' as const, namespace: item.namespace, name: item.name }]
      : []));
  const callables = [...tools, ...calls];
  const reserved = new Set(callables.flatMap(callable => callable.namespace === undefined ? [callable.name] : []));
  const wireNames = assignToolNames(callables, reserved);
  const identities = new Map<string, Pick<IRInputToolSelector, 'namespace' | 'name'>>();
  for (const callable of callables) {
    const wireName = wireNames.get(callableKey(callable))!;
    if (callable.namespace !== undefined || wireName !== callable.name) {
      identities.set(wireName, { name: callable.name, ...(callable.namespace === undefined ? {} : { namespace: callable.namespace }) });
    }
  }
  return { wireNames, identities };
};

/**
 * States this target's request and conversation with wireNames callable names.
 *
 * Declarations and historical calls share one allocation keyed by kind, group,
 * and name. Bare names stay unchanged unless two callable kinds share one. The
 * grouping itself is dropped, because this wire has nowhere to state it. What the
 * returned context carries is what the same spelling decided: which
 * declarations were freeform, and which identity each allocated name came from.
 */
export const allocateToolNames = <Restored>(
  request: IRInputRequestHeader,
  inputTurns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[],
): { readonly request: IRInputRequestHeader; readonly turns: readonly (IRInputTurn | RestoredAssistantTurn<Restored>)[]; readonly context: ToolNameContext } => {
  const irTurns = inputTurns.flatMap(turn => turn.kind === 'restored' ? [] : [turn]);
  const { wireNames, identities: originalToolNames } = allocateCallableNames(request.tools ?? [], irTurns);

  const wireNameOf = (callable: IRInputToolSelector): string => {
    const wireName = wireNames.get(callableKey(callable));
    if (wireName !== undefined) return wireName;
    if (callable.namespace === undefined) return callable.name;
    throw new TranslateInputException(`Cannot translate a selector for undeclared grouped tool '${callable.namespace}.${callable.name}'.`);
  };
  const allocateChoiceNames = (choice: IRInputToolChoice): IRInputToolChoice => {
    if (typeof choice === 'string') return choice;
    if (choice.type === 'allowed_tools') return { ...choice, tools: choice.tools.map(allocateSelectorName) };
    return allocateSelectorName(choice);
  };
  const allocateSelectorName = (selection: IRInputToolSelector): IRInputToolSelector => {
    const { namespace: _namespace, ...rest } = selection;
    return { ...rest, name: wireNameOf(selection) };
  };
  const toolChoice = request.tool_choice === undefined ? undefined : allocateChoiceNames(request.tool_choice);
  const allocateDeclarationName = (tool: IRInputTool): IRInputTool => {
    const { namespace: _namespace, ...rest } = tool;
    return { ...rest, name: wireNameOf(tool) };
  };
  const allocatedRequest: IRInputRequestHeader = {
    ...request,
    ...(request.tools === undefined ? {} : { tools: request.tools.map(allocateDeclarationName) }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
  return {
    request: allocatedRequest,
    context: { customToolNames: customNamesOf(allocatedRequest), originalToolNames },
    turns: inputTurns.map((turn): IRInputTurn | RestoredAssistantTurn<Restored> => {
      if (turn.kind === 'restored') return turn;
      if (turn.kind === 'assistant') {
        return {
          kind: 'assistant',
          items: turn.items.map(item => item.type === 'function_call' || item.type === 'custom_tool_call'
            ? { ...item, name: wireNameOf({ type: item.type === 'function_call' ? 'function' : 'custom', namespace: item.namespace, name: item.name }) }
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
const assignToolNames = (
  callables: readonly IRInputToolSelector[],
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
        throw new TranslateInputException(`Cannot translate ambiguous grouped callables both spelling '${dotted}'.`);
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
      const spelling = `${prefix}${ending}`;
      if (taken.has(spelling)) continue;
      taken.add(spelling);
      assigned.set(key, spelling);
      break;
    }
  }
  return assigned;
};
