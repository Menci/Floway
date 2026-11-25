import { stripHeaders } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L255-L270
const responses = new Set([
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
]);

export const stripResponsesHeaders = stripHeaders('chatgpt.strip-openai-responses-headers', name => responses.has(name));
export const stripAlphaSearchHeaders = stripHeaders('chatgpt.strip-alpha-search-headers', name => name === 'x-codex-turn-metadata');

// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
export const stripOpenAIImagesHeaders = stripHeaders('chatgpt.strip-openai-images-headers', name =>
  name === 'originator' || name === 'x-codex-image-turn-id');
