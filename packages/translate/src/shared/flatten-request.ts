import { assignFlatNames } from './flat-names.ts';
import type { IRInputResolvedTurn } from '../ir/input/segments.ts';
import { irInputToolsForChoice } from '../ir/input/select-tools.ts';
import type { IRInputRequest, IRInputTool, IRInputToolChoice, IRInputToolSelection, IRInputTurn } from '../ir/input/types.ts';
import { TranslatorInputError } from '../types.ts';

/** What a target that writes flat names records for the reader of its answer. */
export interface FlatCallContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly callIdentities: ReadonlyMap<string, { readonly namespace: string; readonly name: string }>;
}

/** The declarations a request offers once its selector is applied, under the names this wire writes. */
const customNamesOf = (request: IRInputRequest): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

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
  request: IRInputRequest,
  pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[],
): { readonly request: IRInputRequest; readonly pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[]; readonly context: FlatCallContext } => {
  const turns = pieces.flatMap(piece => piece.kind === 'resolved' ? [] : [piece]);
  const { flat, identities: callIdentities } = flatNamesOf(request.tools ?? [], turns);
  // Nothing is grouped, so the wire names are the client's own.
  if (flat.size === 0) return { request, pieces, context: { customToolNames: customNamesOf(request), callIdentities } };

  // Every grouped callable was assigned a flat name by the pass above, so a
  // lookup that misses means this request states a group the mapping never saw.
  const nameOf = (namespace: string | undefined, name: string): string => {
    if (namespace === undefined) return name;
    const flatName = flat.get(`${namespace}.${name}`);
    if (flatName === undefined) throw new TranslatorInputError(`Cannot translate a selector for undeclared grouped tool '${namespace}.${name}'.`);
    return flatName;
  };
  const flattenTool = (tool: IRInputTool): IRInputTool => {
    const { namespace: _namespace, ...rest } = tool;
    return { ...rest, name: nameOf(tool.namespace, tool.name) };
  };
  const flattenSelection = (selection: IRInputToolSelection): IRInputToolSelection => ({
    ...selection,
    name: nameOf(selection.namespace, selection.name),
  });
  const flattenChoice = (choice: IRInputToolChoice): IRInputToolChoice => typeof choice === 'string' || choice.type === 'allowed_tools'
    ? typeof choice === 'string' ? choice : { ...choice, tools: choice.tools.map(flattenSelection) }
    : flattenSelection(choice);
  const flattenedRequest: IRInputRequest = {
    ...request,
    ...(request.tools === undefined ? {} : { tools: request.tools.map(flattenTool) }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: flattenChoice(request.tool_choice) }),
  };
  return {
    request: flattenedRequest,
    context: { customToolNames: customNamesOf(flattenedRequest), callIdentities },
    pieces: pieces.map((piece): IRInputTurn | IRInputResolvedTurn<Restored> => {
      if (piece.kind === 'resolved') return piece;
      if (piece.kind === 'assistant') {
        return {
          kind: 'assistant',
          items: piece.items.map(item => item.type === 'function_call' || item.type === 'custom_tool_call'
            ? { ...item, name: nameOf(item.namespace, item.name) }
            : item),
        };
      }
      return piece;
    }),
  };
};
