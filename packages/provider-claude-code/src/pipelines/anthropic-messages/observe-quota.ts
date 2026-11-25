import { defineStage } from './facts.ts';
import { parseClaudeCodeQuotaHeaders } from '../../quota.ts';
import { materializeHeaders } from '@floway-dev/http';

export const observeQuota = defineStage({
  name: 'claude-code.observe-quota',
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: [], consumes: [] },
  },
  execute: async (facts, scope) => {
    const back = await scope.next(facts);
    const transport = back['response.transport'];
    if (!transport.ok) return back;
    const { status, headers } = transport.value;
    if (!(status >= 200 && status < 300) && status !== 429) return back;
    const snapshot = parseClaudeCodeQuotaHeaders(new Headers(materializeHeaders(headers)));
    if (Object.keys(snapshot.raw).length > 0) {
      scope.defer(scope.services.claudeCode.persistQuota(facts['provider.upstream'].id, facts['provider.model'].upstreamModelId, snapshot));
    }
    return back;
  },
});
