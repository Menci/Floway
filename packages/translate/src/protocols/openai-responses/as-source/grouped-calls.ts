import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { assignFlatNames } from '../../../shared/flat-names.ts';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

/** The logical identity of a callable this protocol groups. */
export interface CallableIdentity {
  readonly namespace: string;
  readonly name: string;
  readonly type: 'function_call' | 'custom_tool_call';
}

/**
 * The names a target without namespaces states a grouped call under.
 *
 * This protocol states a grouped callable as a pair, but every other translated
 * target accepts one bare name, so the name that comes back on the returned
 * stream is the flat spelling one of them assigned. Recomputing that assignment
 * over the same IR recovers the pair, which is what lets the client see the
 * call the way it wrote it.
 */
export const groupedCallNamesFromIR = (
  request: IRInputRequest,
  turns: readonly IRInputTurn[],
): Map<string, CallableIdentity> => {
  const tools = request.tools ?? [];
  const calls = turns.flatMap(turn => turn.items.flatMap(item =>
    item.type === 'function_call' || item.type === 'custom_tool_call' ? [item] : []));
  const reserved = new Set([
    ...tools.flatMap(tool => tool.namespace === undefined ? [tool.name] : []),
    ...calls.flatMap(call => call.namespace === undefined ? [call.name] : []),
  ]);
  const grouped = [
    ...tools.flatMap(tool => tool.namespace === undefined ? [] : [{ namespace: tool.namespace, name: tool.name, type: tool.type }]),
    ...calls.flatMap(call => call.namespace === undefined
      ? []
      : [{ namespace: call.namespace, name: call.name, type: call.type === 'custom_tool_call' ? 'custom' as const : 'function' as const }]),
  ];
  const flat = assignFlatNames(grouped, reserved);

  const identities = new Map<string, CallableIdentity>();
  for (const { namespace, name } of grouped) {
    const flatName = flat.get(`${namespace}.${name}`);
    if (flatName === undefined || identities.has(flatName)) continue;
    const kind = grouped.find(candidate => candidate.namespace === namespace && candidate.name === name)?.type;
    identities.set(flatName, { namespace, name, type: kind === 'custom' ? 'custom_tool_call' : 'function_call' });
  }
  return identities;
};

/**
 * States a returned call the way this client wrote it.
 *
 * The upstream was asked with flat names, so every call comes back flat. A call
 * that names a pair this request grouped is restated as that pair; everything
 * else already reads right.
 */
export const restoreGroupedCall = (
  item: OpenAIResponsesOutputItemEx,
  identities: ReadonlyMap<string, CallableIdentity>,
  status: 'in_progress' | 'completed',
): OpenAIResponsesOutputItemEx => {
  if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.namespace !== undefined) return item;
  const identity = identities.get(item.name);
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
