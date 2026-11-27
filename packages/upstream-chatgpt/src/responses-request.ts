import { chatgptModelUsesResponsesLite } from './models.ts';
import type { UpstreamModelSnapshot } from '@floway-dev/upstream';

// Standard ChatGPT-subscription models require nonempty instructions. Lite
// carries the caller's instructions in a tagged developer input item.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const withDefaultInstructions = <Payload extends { instructions?: string | null }>(
  payload: Payload, model: Pick<UpstreamModelSnapshot, 'id' | 'upstreamData'>,
): Payload => !chatgptModelUsesResponsesLite(model) && (payload.instructions == null || payload.instructions === '')
  ? { ...payload, instructions: "You're a helpful assistant." }
  : payload;

// The subscription backend's Codex client has a narrower request contract.
// https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/core/src/client.rs#L876-L1000
const CHATGPT_UNSUPPORTED_BODY_FIELDS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
] as const;

export const withoutUnsupportedFields = <Payload extends object>(payload: Payload): Payload => {
  const next = { ...payload };
  for (const key of CHATGPT_UNSUPPORTED_BODY_FIELDS) Reflect.deleteProperty(next, key);
  return next;
};
