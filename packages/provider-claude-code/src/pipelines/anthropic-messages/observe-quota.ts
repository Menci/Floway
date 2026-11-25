import { defineStage } from './facts.ts';
import { claudeCodeUpstreamModelId } from '../../models.ts';
import { parseClaudeCodeQuotaHeaders } from '../../quota.ts';
import { filterHeaders } from '@floway-dev/http';

export const observeQuota = defineStage({
  name: 'claude-code.anthropic-messages.observe-quota',
  through: {
    request: { needs: ['provider.upstream', 'provider.model'], provides: [], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const http = answer['response.http'];
    if (http === null || ((http.status < 200 || http.status >= 300) && http.status !== 429)) return answer;

    const headers = new Headers();
    for (const [name, value] of filterHeaders(http.headers, name => name.startsWith('anthropic-ratelimit-'))) {
      if (typeof value !== 'string') throw new TypeError(`Claude Code quota response header ${name} must be a string`);
      headers.append(name, value);
    }
    const snapshot = parseClaudeCodeQuotaHeaders(headers);
    if (Object.keys(snapshot.raw).length === 0) return answer;

    const { id } = facts['provider.upstream'];
    const upstreamModelId = claudeCodeUpstreamModelId(facts['provider.model']);
    const fetchedAt = Date.now();
    scope.detach(async ({ services, log }) => {
      try {
        await services.claudeCode.persistQuota(id, upstreamModelId, snapshot, fetchedAt, log);
      } catch (error) {
        log.withField('upstream_id', id).withError(error).warn('claude_code_quota_persist_failed');
      }
    });
    return answer;
  },
});
