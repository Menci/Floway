import { stripHeaders } from '@floway-dev/provider';

export const stripOllamaHeaders = stripHeaders('ollama.strip-headers', () => false);
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const stripAnthropicMessagesHeaders = stripHeaders('ollama.strip-anthropic-messages-headers', name => name === 'anthropic-beta');
