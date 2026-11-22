import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

export const injectIdentityBlockPayload = <P extends MessagePayload>(payload: P): P => {
  if (!Array.isArray(payload.system)) {
    throw new Error('injectIdentityBlockPayload requires the billing stage to create the system array');
  }
  return { ...payload, system: [...payload.system, IDENTITY_BLOCK] };
};
