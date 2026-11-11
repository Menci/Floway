import type { IRInputTool, IRInputToolChoice } from './types.ts';

/**
 * The selected callable kinds, used to identify returned tool calls.
 *
 * Request writers keep the complete declaration list: changing it to express
 * a selection changes the prompt cache prefix. Selection belongs only in the
 * target's tool-choice field.
 *
 * The selection names a kind as well as a name because a request may declare a
 * function and a custom tool that share a name; only the matching kind is
 * selected.
 */
export const irInputToolsForChoice = (
  tools: readonly IRInputTool[] | undefined,
  choice: IRInputToolChoice | undefined,
): readonly IRInputTool[] | undefined => {
  if (tools === undefined || choice === undefined || typeof choice === 'string' || choice.type !== 'allowed_tools') return tools;
  const permitted = new Set(choice.tools.map(selection => `${selection.type}:${selection.name}`));
  return tools.filter(tool => permitted.has(`${tool.type}:${tool.name}`));
};

/**
 * The choice a writer states beside the request's declarations.
 *
 * `none` and `auto` describe how the model behaves with the declarations in
 * hand, so they are stated even when there are none. `required` and a named
 * selector demand a callable that is not offered, so they are not stated;
 * with no declarations, an optional subset states `none`.
 *
 * A writer whose upstream rejects an orphaned `tool_choice` suppresses the
 * result when no declaration survives; that is the OpenAI wires' own rule, and
 * it belongs to them rather than here.
 */
export const irInputToolChoiceForTools = (
  choice: IRInputToolChoice | undefined,
  tools: readonly IRInputTool[] | undefined,
): IRInputToolChoice | undefined => {
  if (choice === undefined) return undefined;
  if (tools !== undefined && tools.length > 0) return choice;
  if (choice === 'none' || choice === 'auto') return choice;
  if (typeof choice === 'object' && choice.type === 'allowed_tools' && choice.mode === 'auto') return 'none';
  return undefined;
};
