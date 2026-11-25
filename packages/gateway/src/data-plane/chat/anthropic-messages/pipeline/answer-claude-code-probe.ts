import { synthesizeClaudeCodeProbe } from './synthesize-claude-code-probe.ts';
import { computeUsage } from '../../../pipeline/compute-usage.ts';
import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { storeUsage, type UsageStoreServices } from '../../../pipeline/store-usage.ts';
import { tokenUsageMeasurement } from '../../../shared/telemetry/usage.ts';
import { getHeader } from '@floway-dev/http';
import type { AnthropicMessagesCountTokensPayload } from '@floway-dev/protocols/anthropic-messages';

const { compose, defineStage } = gatewayFactSpace<UsageStoreServices>();
const requestKey = 'request.anthropicMessages';
const response = ['response.http', 'response.anthropicMessages'] as const;

const probeResult = compose('anthropicMessages.claude-code-probe', {
  entry: ['request.auth.apiKeyId', 'serve.candidate'],
  exit: response,
  stages: [storeUsage, computeUsage('response.anthropicMessages', {
    kind: 'billable',
    stream: () => ({ observe: () => tokenUsageMeasurement(null), finish: () => null }),
  })],
  ending: synthesizeClaudeCodeProbe,
});

// Claude Code 2.1.226 issues these exact one-token probes for model validation
// and credential checks. The validation path reads the usage counters even
// when generation returned no content.
// https://github.com/BerriAI/litellm/issues/35061
const promptOf = (payload: AnthropicMessagesCountTokensPayload): string | undefined => {
  const [message] = payload.messages;
  if (payload.messages.length !== 1 || message?.role !== 'user') return undefined;
  const { content } = message;
  if (typeof content === 'string') return content;
  const [block] = content;
  return content.length === 1 && block?.type === 'text' ? block.text : undefined;
};

export const answerClaudeCodeProbe = defineStage({
  name: 'anthropicMessages.answer-claude-code-probe',
  through: {
    request: { needs: [requestKey, 'request.http', 'request.auth.apiKeyId', 'serve.candidate'], provides: [], consumes: [] },
    response: { needs: response, provides: [], consumes: [] },
  },
  return: { provides: response },
  async execute(facts, scope) {
    const payload = facts[requestKey];
    const userAgent = getHeader(facts['request.http'].headers, 'user-agent');
    if (!('max_tokens' in payload) || payload.max_tokens !== 1 || payload.tools !== undefined
      || typeof userAgent !== 'string' || !/^claude-cli\/\d+\.\d+\.\d+/i.test(userAgent)) return await scope.next(facts);
    const prompt = promptOf(payload);
    return prompt === 'Hi' || prompt === 'test' ? await scope.run(probeResult, facts) : await scope.next(facts);
  },
});
