import { stripHeaders } from '@floway-dev/provider';

export const stripClientHeaders = stripHeaders('copilot.stripClientHeaders', () => false);
export const stripAnthropicMessagesClientHeaders = stripHeaders('copilot.anthropicMessages.stripClientHeaders', name => name === 'anthropic-beta');
