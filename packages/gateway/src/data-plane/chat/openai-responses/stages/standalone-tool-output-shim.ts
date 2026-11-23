import { responsesInputShim } from './input-shim.ts';
import { standaloneToolOutputContent } from '../items/standalone-tool-output-content.ts';

// Codex sends context fragments as tool outputs without a preceding call.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
export const standaloneToolOutputShim = responsesInputShim('standaloneToolOutputShim', 'openai-responses-standalone-tool-output-shim', (item, index) =>
  item.type === 'function_call_output' && item.call_id == null
    ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) }
    : item);
