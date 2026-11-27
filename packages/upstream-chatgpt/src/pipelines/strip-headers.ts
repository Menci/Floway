import { defineStage } from './facts.ts';
import { filterHeaders } from '@floway-dev/http';

// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
// https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
// https://github.com/openai/codex/blob/646f7c0a91b8e327d263335da68ae8ef212895ce/codex-rs/ext/image-generation/src/backend.rs#L81-L89
const headersToKeep = new Set([
  'originator',
  'session-id',
  'session_id',
  'thread-id',
  'x-client-request-id',
  'x-codex-image-turn-id',
  'x-codex-turn-metadata',
  'x-codex-window-id',
]);

export const stripHeaders = defineStage({
  name: 'chatgpt.stripHeaders',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { http } = facts;
    return await scope.next({ ...facts, http: { ...http, headers: filterHeaders(http.headers, name => headersToKeep.has(name)) } });
  },
});
