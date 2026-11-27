import { OpenAIResponsesInvalidInputError } from './invalid-input.ts';
import type { OpenAIResponsesFunctionCallOutputItem, OpenAIResponsesInputContent } from '@floway-dev/protocols/openai-responses';

// Codex renders the same additional context as a user message wrapped in
// `<external_{name}>` markers when `untrusted_as_tool_output` is disabled; the
// lowering reproduces that representation so the model reads what Codex
// itself would send.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L59-L148
export const standaloneToolOutputContent = (
  item: OpenAIResponsesFunctionCallOutputItem,
  index: number,
): OpenAIResponsesInputContent[] => {
  // Matches the OpenAI Responses rejection of a nameless standalone output.
  // https://github.com/parthg1901/windlass/blob/758b8e94ac4d464a7bb62d41a13bd639de744ec3/docs/reference/responses-api.md?plain=1#L548-L549
  if (typeof item.name !== 'string' || item.name === '') {
    throw new OpenAIResponsesInvalidInputError('A function call output without a call_id requires a name.', `input[${index}].name`);
  }
  const open = `<external_${item.name}>`;
  const close = `</external_${item.name}>`;
  if (typeof item.output === 'string') return [{ type: 'input_text', text: `${open}${item.output}${close}` }];

  const content: OpenAIResponsesInputContent[] = [{ type: 'input_text', text: open }];
  for (const part of item.output) {
    const last = content.at(-1);
    if (part.type === 'input_text' && last?.type === 'input_text') last.text += part.text;
    else content.push(part);
  }
  const last = content.at(-1);
  if (last?.type === 'input_text') last.text += close;
  else content.push({ type: 'input_text', text: close });
  return content;
};
