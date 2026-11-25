import { stripHeaders } from '@floway-dev/provider';

export const stripAzureHeaders = stripHeaders('azure.strip-headers', () => false);

// The Anthropic ingress and translation stages own the beta list.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
export const stripAzureAnthropicMessagesHeaders = stripHeaders('azure.anthropicMessages.strip-headers', name => name === 'anthropic-beta');
