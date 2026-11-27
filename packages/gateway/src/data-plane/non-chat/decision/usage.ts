import { defineStage } from './facts.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { isJsonObject, parseDecimalString, type DecisionProtocol } from '@floway-dev/protocols/common';
import { decodeDecisionResponse, parseDecisionUsage } from '@floway-dev/protocols/decision';
import { parseJsonBody, type UpstreamOutcome } from '@floway-dev/upstream';

type DecisionOutcome = UpstreamOutcome<'decision'>;

const invalidResult = (message: string): DecisionOutcome => ({
  kind: 'error',
  source: 'upstream',
  error: { error: { type: 'server_error', message } },
});

const normalizeResult = (
  outcome: DecisionOutcome,
  sourceDialect: DecisionProtocol,
  targetDialect: DecisionProtocol,
): { outcome: DecisionOutcome; inputTokens: number | undefined } => {
  if (outcome.kind === 'error') return { outcome, inputTokens: undefined };

  const { result } = outcome;
  const body = result instanceof Uint8Array ? parseJsonBody(result) : { ok: true as const, value: result.raw };
  if (!body.ok) return { outcome: invalidResult(body.error.message), inputTokens: undefined };
  if (!isJsonObject(body.value)) return { outcome: invalidResult('Decision response body must be an object'), inputTokens: undefined };

  const { inputTokens } = parseDecisionUsage(body.value);
  if (!(result instanceof Uint8Array) || sourceDialect === targetDialect) return { outcome, inputTokens };

  const decoded = decodeDecisionResponse(targetDialect, body.value);
  return {
    outcome: decoded.ok ? { kind: 'result', result: decoded.value } : invalidResult(decoded.error.message),
    inputTokens,
  };
};

export const computeUsage = defineStage({
  name: 'decision.compute-usage',
  through: {
    request: { needs: ['model', 'decision'], provides: [], consumes: [] },
    response: { needs: ['decision', 'usageModelKey?'], provides: ['decision', 'usage'], consumes: ['usageModelKey'] },
  },
  async execute(facts, scope) {
    const { decision, usageModelKey, ...answer } = await scope.next(facts);
    const { decisionTarget, upstreamModelId } = facts.model;
    if (decisionTarget === undefined) throw new Error(`Decision model ${facts.model.id} has no outbound target`);
    const { outcome, inputTokens } = normalizeResult(decision, facts.decision.sourceProtocol, decisionTarget.protocol);
    const { usage } = observeUsage(scope, inputTokens === undefined ? outcome : decision, usageModelKey ?? upstreamModelId, {
      result: () => inputTokens === undefined
        ? [requestOnlyUsageMeasurement()]
        : [{
            quantities: { input_tokens: parseDecimalString(String(inputTokens)) },
            pricingFacts: { inputTokens },
            dumpTokenUsage: null,
          }],
    });
    return { ...answer, decision: outcome, usage };
  },
});
