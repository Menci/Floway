import { stripHeaders } from '@floway-dev/provider';

export const stripOllamaHeaders = stripHeaders('ollama.stripHeaders', () => false);
export const stripOllamaAnthropicMessagesHeaders = stripHeaders('ollama.stripHeaders', name => name === 'anthropic-beta');
