import type { IRInputTool, IRInputToolChoice } from './types.ts';

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
