import { defineStage } from './facts.ts';
import type { UsageQuantities } from '../../../repo/types.ts';
import { observeUsage } from '../../pipeline/compute-usage.ts';
import { isJsonObject, parseDecimalString, type RerankProtocol } from '@floway-dev/protocols/common';
import { decodeRerankResponse, parseRerankUsage, RerankResponseValidationError, type CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import { parseJsonBody, type UpstreamOutcome } from '@floway-dev/upstream';

type RerankOutcome = UpstreamOutcome<'rerank'>;
type RerankUsage = ReturnType<typeof parseRerankUsage>;

const invalidResult = (message: string): RerankOutcome => ({
  kind: 'error',
  source: 'upstream',
  error: { error: { type: 'server_error', message } },
});

const normalizeResult = (
  outcome: RerankOutcome,
  dialect: RerankProtocol,
  request: CanonicalRerankRequest,
): { outcome: RerankOutcome; reported: RerankUsage } => {
  if (outcome.kind === 'error') return { outcome, reported: {} };

  const { result } = outcome;
  const body = result instanceof Uint8Array ? parseJsonBody(result) : { ok: true as const, value: result.raw };
  if (!body.ok) return { outcome: invalidResult(body.error.message), reported: {} };
  if (!isJsonObject(body.value)) return { outcome: invalidResult('Rerank response body must be an object'), reported: {} };

  let reported: RerankUsage;
  try {
    reported = parseRerankUsage(dialect, body.value);
  } catch (error) {
    if (!(error instanceof RerankResponseValidationError)) throw error;
    return { outcome: invalidResult(error.message), reported: {} };
  }

  if (request.sourceProtocol === dialect) return { outcome, reported };

  const decoded = decodeRerankResponse(dialect, body.value);
  if (!decoded.ok) return { outcome: invalidResult(decoded.error.message), reported };
  const invalid = decoded.value.results.find(({ index }) => index >= request.documents.length);
  return {
    outcome: invalid === undefined
      ? { kind: 'result', result: decoded.value }
      : invalidResult(`Rerank response result index ${invalid.index} is outside the request documents array`),
    reported,
  };
};

export const computeUsage = defineStage({
  name: 'rerank.compute-usage',
  through: {
    request: { needs: ['model', 'rerank'], provides: [], consumes: [] },
    response: { needs: ['rerank', 'rerankTargetDialect'], provides: ['rerank', 'usage'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { outcome: rerank, reported: { searchUnits, totalTokens } } = normalizeResult(answer.rerank, answer.rerankTargetDialect, facts.rerank);
    // A provider can report usable billing data alongside invalid ranked items.
    const billable = searchUnits !== undefined || totalTokens !== undefined;
    const { usage } = observeUsage(scope, billable ? answer.rerank : rerank, facts.model.upstreamModelId, {
      result() {
        const quantities: UsageQuantities = {};
        if (searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(searchUnits));
        if (totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(totalTokens));
        return [{ quantities, pricingFacts: totalTokens === undefined ? {} : { inputTokens: totalTokens }, dumpTokenUsage: null }];
      },
    });
    return { ...answer, rerank, usage };
  },
});
