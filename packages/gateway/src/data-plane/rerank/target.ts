import { rerankRequestIncompatibility, type CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import { providerModelOf } from '@floway-dev/provider';

/** A candidate that cannot serve *this* request is not a candidate. Saying why is what
 *  turns an empty list into a 400 a client can act on. */
export const narrowing = (request: CanonicalRerankRequest) => ({
  kind: 'rerank' as const,
  reject: (candidate: Parameters<typeof providerModelOf>[0]) => {
    const model = providerModelOf(candidate);
    if (candidate.model.endpoints.rerank === undefined || model.rerankTarget === undefined) {
      return 'the upstream does not expose a rerank endpoint';
    }
    return rerankRequestIncompatibility(model.rerankTarget.protocol, request);
  },
  unsupported: (model: string, reasons: readonly string[]) => reasons.length === 0
    ? `Model ${model} does not support rerank.`
    : `Model ${model} does not support this rerank request: ${reasons.join('; ')}.`,
  refuse: (status: number, message: string) => ({ 'response.rerank.canonical': { status, message } }),
  refuses: ['response.rerank.canonical'] as const,
});
