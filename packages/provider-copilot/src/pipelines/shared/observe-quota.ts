import { hasCopilotQuotaHeaders, type CopilotServices } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import type { HttpHeaders } from '@floway-dev/http';

interface QuotaLog {
  withField(name: string, value: string): QuotaLog;
  withError(error: unknown): QuotaLog;
  warn(message: string): void;
}

interface QuotaScope {
  detach(worker: (scope: { log: QuotaLog; services: Readonly<CopilotServices> }) => Promise<unknown>): void;
}

export const detachCopilotQuota = (scope: QuotaScope, upstreamId: string, headers: HttpHeaders): void => {
  if (!hasCopilotQuotaHeaders(headers)) return;
  scope.detach(async ({ services, log }) => {
    try {
      await services.copilot.observeQuota(upstreamId, headers);
    } catch (error) {
      log.withField('upstreamId', upstreamId).withError(error).warn('Failed to record Copilot quota');
    }
  });
};

export const observeQuota = defineCopilotStage({
  name: 'copilot.observeQuota',
  through: {
    request: { needs: ['provider.upstream'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const http = answer['response.http'];
    if (http !== null) detachCopilotQuota(scope, facts['provider.upstream'].id, http.headers);
    return answer;
  },
});
