import { assignFlatNames } from './flat-names.ts';
import type { IRInputResolvedTurn } from '../ir/input/segments.ts';
import { irInputToolsForChoice } from '../ir/input/select-tools.ts';
import type { IRInputRequest, IRInputTool, IRInputToolChoice, IRInputToolSelection, IRInputTurn } from '../ir/input/types.ts';

/**
 * The flat name each grouped callable gets on a protocol without namespaces.
 *
 * A protocol that addresses a callable by one bare name has to spell a grouped
 * declaration out, and the spelling must avoid every name the request already
 * uses. That is a fact about the whole conversation, so the mapping is computed
 * once over the declarations and the calls together — not per declaration.
 */
const flatNameMapping = (
  tools: readonly IRInputTool[],
  turns: readonly IRInputTurn[],
): Map<string, string> => {
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
  return assignFlatNames(grouped, reserved);
};

/** What a target that writes flat names records for the reader of its answer. */
export interface FlatCallContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly callIdentities: ReadonlyMap<string, { readonly namespace: string; readonly name: string }>;
}

/** The declarations a request offers once its selector is applied, under the names this wire writes. */
const customNamesOf = (request: IRInputRequest): ReadonlySet<string> =>
  new Set((irInputToolsForChoice(request.tools, request.tool_choice) ?? [])
    .flatMap(tool => tool.type === 'custom' ? [tool.name] : []));

/** The pair each flat name stands for, read off the same assignment. */
const identitiesFrom = (flat: ReadonlyMap<string, string>): Map<string, { readonly namespace: string; readonly name: string }> => {
  const identities = new Map<string, { readonly namespace: string; readonly name: string }>();
  for (const [key, flatName] of flat) {
    const dot = key.indexOf('.');
    identities.set(flatName, { namespace: key.slice(0, dot), name: key.slice(dot + 1) });
  }
  return identities;
};

/** What a target that writes flat names records for the reader of its answer. */
export interface FlatCallContext {
  readonly customToolNames: ReadonlySet<string>;
  readonly callIdentities: ReadonlyMap<string, { readonly namespace: string; readonly name: string }>;
}

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
  const flat = flatNameMapping(request.tools ?? [], turns);
  const callIdentities = identitiesFrom(flat);
  // Nothing is grouped, so the wire names are the client's own.
  if (flat.size === 0) return { request, pieces, context: { customToolNames: customNamesOf(request), callIdentities } };

  const nameOf = (namespace: string | undefined, name: string): string =>
    namespace === undefined ? name : flat.get(`${namespace}.${name}`) ?? name;
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
