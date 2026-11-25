import { stripHeaders } from '@floway-dev/provider';

export const stripAzureHeaders = stripHeaders('azure.stripHeaders', () => false);
export const stripAzureAnthropicMessagesHeaders = stripHeaders('azure.stripHeaders', name => name === 'anthropic-beta');
