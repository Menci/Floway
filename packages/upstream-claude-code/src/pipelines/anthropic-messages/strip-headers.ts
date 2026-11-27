import { defineStage } from './facts.ts';
import { CLAUDE_CODE_INBOUND_HEADER_ALLOWLIST } from '../../headers.ts';
import { filterHeaders } from '@floway-dev/http';

export const stripHeaders = defineStage({
  name: 'claude-code.anthropic-messages.strip-headers',
  through: {
    request: { needs: ['http'], provides: ['http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const headers = filterHeaders(facts.http.headers, name =>
      name === 'anthropic-beta' || CLAUDE_CODE_INBOUND_HEADER_ALLOWLIST.some(rule =>
        typeof rule === 'string' ? rule === name : rule.test(name)));
    return await scope.next({ ...facts, http: { ...facts.http, headers } });
  },
});
