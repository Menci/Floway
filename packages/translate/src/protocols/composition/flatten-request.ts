import type { ResolvedTurn } from './segments.ts';
import { irInputToolsForChoice } from '../../ir/input/select-tools.ts';
import type { IRInputRequestHeader, IRInputTool, IRInputToolChoice, IRInputToolSelector, IRInputTurn } from '../../ir/input/types.ts';
import { TranslatorInputError } from '../../types.ts';

/** What a target that writes flat names records for the reader of its answer. */
export interface FlatCallContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly flatIdentities: ReadonlyMap<string, { readonly namespace: string; readonly name: string }>;
}

/**
 * The names this wire reports as freeform calls.
 *
 * A target reading its answer back sees a call's name and nothing else, so a
 * name that is both a function and a custom tool cannot be classified: the
 * answer would be reported in whichever shape this set picks. Such a name is
 * left out, which reports the answer as the function call it most likely is,
 * and the wire's own declarations keep the two kinds distinct.
 */
const customNamesOf = (request: IRInputRequestHeader): ReadonlySet<string> => {
  const tools = irInputToolsForChoice(request.tools, request.tool_choice) ?? [];
  const functionNames = new Set(tools.flatMap(tool => tool.type === 'function' ? [tool.name] : []));
  return new Set(tools.flatMap(tool => tool.type === 'custom' && !functionNames.has(tool.name) ? [tool.name] : []));
};

/**
 * The pair each grouped callable stands for, keyed by the flat name it got.
 *
 * Both halves come out of one `assignFlatNames` pass, so the inversion is read
 * off the pairs that were assigned rather than parsed back out of their key: a
 * namespace or a name may itself contain the separator.
 */
const flatNamesOf = (
  tools: readonly IRInputTool[],
  turns: readonly IRInputTurn[],
): { readonly flat: ReadonlyMap<string, string>; readonly identities: Map<string, { readonly namespace: string; readonly name: string }> } => {
  const calls = turns.flatMap(turn => turn.items.flatMap(item =>
    item.type === 'function_call' || item.type === 'custom_tool_call' ? [item] : []));
  const reserved = new Set([
    ...tools.flatMap(tool => tool.namespace === undefined ? [tool.name] : []),
    ...calls.flatMap(call => call.namespace === undefined ? [call.name] : []),
  ]);
  const grouped = [
    ...tools.flatMap(tool => tool.namespace === undefined ? [] : [{ namespace: tool.namespace, name: tool.name }]),
    // A call can name a group the request never declared; it still needs a flat
    // spelling so the result that answers it lines up.
    ...calls.flatMap(call => call.namespace === undefined ? [] : [{ namespace: call.namespace, name: call.name }]),
  ];
  const flat = assignFlatNames(grouped, reserved);
  const identities = new Map<string, { readonly namespace: string; readonly name: string }>();
  for (const { namespace, name } of grouped) {
    const flatName = flat.get(`${namespace}.${name}`);
    if (flatName !== undefined) identities.set(flatName, { namespace, name });
  }
  return { flat, identities };
};

/**
 * States this target's request and conversation with flat callable names.
 *
 * Grouped declarations and the calls that answer them are spelled the way this
 * target writes them; everything already flat keeps its name. The grouping
 * itself is dropped, because this wire has nowhere to state it. What the
 * returned context carries is what the same spelling decided: which
 * declarations were freeform, and which pair each flat name came from.
 */
export const flattenRequestNames = <Restored>(
  request: IRInputRequestHeader,
  inputTurns: readonly (IRInputTurn | ResolvedTurn<Restored>)[],
): { readonly request: IRInputRequestHeader; readonly turns: readonly (IRInputTurn | ResolvedTurn<Restored>)[]; readonly context: FlatCallContext } => {
  const irTurns = inputTurns.flatMap(turn => turn.kind === 'resolved' ? [] : [turn]);
  const { flat, identities: flatIdentities } = flatNamesOf(request.tools ?? [], irTurns);

  // Every grouped callable was assigned a flat name by the pass above, so a
  // lookup that misses means this request states a group the mapping never saw.
  // This runs even when nothing is grouped: a selector that names a group
  // cannot be carried by a wire that has no grouped declarations to spell.
  const nameOf = (namespace: string | undefined, name: string): string => {
    if (namespace === undefined) return name;
    const flatName = flat.get(`${namespace}.${name}`);
    if (flatName === undefined) throw new TranslatorInputError(`Cannot translate a selector for undeclared grouped tool '${namespace}.${name}'.`);
    return flatName;
  };
  const flattenChoice = (choice: IRInputToolChoice): IRInputToolChoice => {
    if (typeof choice === 'string') return choice;
    if (choice.type === 'allowed_tools') return { ...choice, tools: choice.tools.map(flattenSelection) };
    return flattenSelection(choice);
  };
  const flattenSelection = (selection: IRInputToolSelector): IRInputToolSelector => ({
    ...selection,
    name: nameOf(selection.namespace, selection.name),
  });
  const toolChoice = request.tool_choice === undefined ? undefined : flattenChoice(request.tool_choice);

  // Nothing is grouped, so every remaining wire name is the client's own. The
  // selector is still the resolved one: a group it names has to be refused.
  if (flat.size === 0) {
    return {
      request: toolChoice === undefined ? request : { ...request, tool_choice: toolChoice },
      turns: inputTurns,
      context: { customToolNames: customNamesOf(request), flatIdentities },
    };
  }

  const flattenTool = (tool: IRInputTool): IRInputTool => {
    const { namespace: _namespace, ...rest } = tool;
    return { ...rest, name: nameOf(tool.namespace, tool.name) };
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
            ? { ...item, name: nameOf(item.namespace, item.name) }
            : item),
        };
      }
      return turn;
    }),
  };
};

/**
 * The flat wire name a namespaced callable gets on a protocol without
 * namespaces.
 *
 * Chat Completions and Messages address a callable by one bare name, so a
 * declaration that lives in a group has to be spelled out. Two steps are pure
 * functions of the pair — the name is cut to the 64 ASCII characters Chat
 * allows and every character it cannot carry becomes `_`:
 *
 * https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
 *
 * What is not a function of the pair is the collision suffix: two different
 * groups can spell the same flat name, and which one gets `_2` depends on what
 * was allocated before it. That is why the caller walks the whole conversation
 * in one pass rather than mapping each declaration alone.
 */
interface GroupedCallable {
  readonly namespace: string;
  readonly name: string;
}

/**
 * Assigns one flat name per grouped callable, in the order they are given.
 *
 * `reserved` holds the names the request already uses without a group; a
 * grouped callable must not take one of them, and must not take a name this
 * pass has already handed out.
 */
const assignFlatNames = <T extends GroupedCallable>(
  callables: readonly T[],
  reserved: ReadonlySet<string>,
): Map<string, string> => {
  const taken = new Set(reserved);
  const nextSuffixes = new Map<string, number>();
  const assigned = new Map<string, string>();
  // A pair identifies one callable; its dotted spelling does not. Two different
  // groups can spell the same key — `a` + `b.c` and `a.b` + `c` both read
  // `a.b.c` — and merging those would hand two declarations one wire name.
  const assignedPairs = new Map<string, { readonly namespace: string; readonly name: string }>();
  for (const { namespace, name } of callables) {
    const key = `${namespace}.${name}`;
    const prior = assignedPairs.get(key);
    if (prior !== undefined) {
      if (prior.namespace === namespace && prior.name === name) continue;
      throw new TranslatorInputError(`Cannot translate ambiguous grouped callables both spelling '${key}'.`);
    }
    assignedPairs.set(key, { namespace, name });
    const scope = `${namespace.slice(0, 64)}_`.slice(0, 64);
    const base = `${scope}${name.slice(0, 64 - scope.length)}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
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
