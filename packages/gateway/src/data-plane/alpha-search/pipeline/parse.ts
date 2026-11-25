import { HTTPException } from 'hono/http-exception';

import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { responseHead } from '../../pipeline/response.ts';
import { alphaSearchRequestSchema } from '../schema.ts';
import { getHeader, readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { formatAlphaSearchError } from '@floway-dev/protocols/alpha-search';
import { mediaTypeEssence } from '@floway-dev/protocols/common';

const { defineStage } = gatewayFactSpace<{}>();

const invalid = (status: number, error: unknown) => ({
  'response.http': move(responseHead(status)),
  'response.alphaSearch': move({ kind: 'error', source: 'local', error } as const),
});

export const alphaSearchModelNotFound = () => invalid(404, formatAlphaSearchError(404, 'Search model not found.'));

export const parseAlphaSearch = defineStage({
  name: 'alphaSearch.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.alphaSearch'], consumes: [] },
    response: { needs: ['response.http', 'response.alphaSearch'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.alphaSearch'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const raw = await readHttpBody(request.body);
    const header = getHeader(request.headers, 'content-type');
    const contentType = typeof header === 'string' ? mediaTypeEssence(header) : null;
    let body: unknown = {};
    // https://github.com/honojs/hono/blob/v4.13.20/src/validator/validator.ts
    if (contentType !== null && /^application\/(?:[\w.-]+\+)?json$/i.test(contentType)) {
      if (!raw.ok) throw new HTTPException(400, { message: 'Malformed JSON in request body' });
      try {
        body = JSON.parse(new TextDecoder().decode(raw.value));
      } catch {
        throw new HTTPException(400, { message: 'Malformed JSON in request body' });
      }
    }

    const parsed = alphaSearchRequestSchema.safeParse(body);
    if (!parsed.success) return invalid(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return await scope.next({ ...facts, 'request.alphaSearch': move(parsed.data) });
  },
});
