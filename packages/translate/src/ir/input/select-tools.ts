import type { IRInputTool, IRInputToolChoice } from './types.ts';

/**
 * The declarations a request may offer once its selector is applied.
 *
 * Only `allowed_tools` narrows what the model may see. A named selector, a
 * mode, or a missing selector leaves every declaration visible: `required` and
 * a named tool say which callable the model must choose, not which ones it may
 * know about.
 *
 * A writer narrows the list because that is the one spelling every upstream
 * understands, while a selector arm of its own may be unimplemented. The
 * written choice then carries only the mode.
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
 * The choice a writer states beside the declarations it ended up offering.
 *
 * `none` and `auto` describe how the model behaves with the declarations in
 * hand, so they are stated even when there are none. `required` and a named
 * selector demand a callable that is not offered, so they are not stated;
 * a subset that selects nothing states `none` rather than letting `auto` reach
 * for a tool the request no longer offers.
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
