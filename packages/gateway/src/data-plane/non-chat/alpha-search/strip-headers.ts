import { defineStage } from '../../pipeline/facts.ts';
import { filterHeaders } from '@floway-dev/http';

// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
export const stripHeaders = defineStage({
  name: 'alphaSearch.strip-headers',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute({ http, ...facts }, scope) {
    return await scope.next({ ...facts, http: { ...http, headers: filterHeaders(http.headers, name => name === 'x-codex-turn-metadata') } });
  },
});
