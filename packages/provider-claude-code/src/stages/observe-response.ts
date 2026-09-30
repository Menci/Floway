import { detectTerminalSentinel, persistQuotaSnapshot, persistTerminalAccountState } from '../backend.ts';
import type { ClaudeCodeHttpRequest } from '../pipeline-facts.ts';
import { parseClaudeCodeQuotaHeaders } from '../quota.ts';
import { exchangeResponse, takeHttpResponse } from '@floway-dev/http/pipeline';
import { defer, defineStage, move, setRelease, type Deferred } from '@floway-dev/pipeline';
import type { ProviderResponse } from '@floway-dev/provider';

type Observed = ProviderResponse & { 'response.claudeCode.background': Deferred<unknown>; 'response.claudeCode.failureBody': unknown };

export const observeClaudeCodeResponse = (upstreamId: string) => defineStage<ClaudeCodeHttpRequest, ClaudeCodeHttpRequest, ProviderResponse, Observed>({
  name: 'observeClaudeCodeResponse',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.claudeCode.background', 'response.claudeCode.failureBody'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    const tasks: Promise<unknown>[] = [];
    if (exchange.type === 'transportFailure') return move({ ...back, 'response.claudeCode.background': defer(Promise.all(tasks)), 'response.claudeCode.failureBody': null });
    const response = exchangeResponse(exchange);
    if (response.ok || response.status === 429) {
      const quota = parseClaudeCodeQuotaHeaders(response.headers);
      if (Object.keys(quota.raw).length > 0) tasks.push(persistQuotaSnapshot(upstreamId, quota, use.log.info));
    }
    let failureBody: unknown = null;
    let retained = exchange;
    if (response.status === 400 || response.status === 403) {
      const text = await response.text();
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      try { failureBody = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; failureBody = text; }
      const terminal = detectTerminalSentinel(response.status, text);
      if (terminal !== null) tasks.push(persistTerminalAccountState(upstreamId, terminal, response.status === 400 ? 'org_disabled_400_sentinel' : 'org_banned_403_sentinel', response.status, use.log.warn));
      retained = takeHttpResponse(new Response(text, { status: exchange.status, statusText: exchange.statusText, headers: response.headers }));
    }
    return move({
      ...back, 'response.http.exchange': retained, 'response.http.body': retained.body,
      'response.claudeCode.background': defer(Promise.all(tasks)), 'response.claudeCode.failureBody': failureBody,
    });
  },
});
