import { stripHeaders } from '@floway-dev/provider';

export const stripOpenAIHeaders = stripHeaders('kimi-code.strip-openai-headers', () => false);
export const stripAnthropicMessagesHeaders = stripHeaders('kimi-code.strip-anthropic-messages-headers', name => name === 'anthropic-beta');
