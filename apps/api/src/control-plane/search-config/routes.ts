import type { Context } from 'hono';

import { testSearchConfigConnection } from '../../data-plane/tools/web-search/provider.ts';
import { loadSearchConfig, normalizeSearchConfig, saveSearchConfig } from '../../data-plane/tools/web-search/search-config.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import type { searchConfigSchema } from '../schemas.ts';

export const getSearchConfigRoute = async (c: Context) => c.json(await loadSearchConfig());

export const putSearchConfigRoute = async (c: CtxWithJson<typeof searchConfigSchema>) => {
  // saveSearchConfig still runs normalizeSearchConfig for the canonical shape
  // (defaulting nulls, trimming strings); the schema guarantees the discriminator
  // and presence of nested apiKey fields.
  const config = await saveSearchConfig(c.req.valid('json'));
  return c.json(config);
};

export const testSearchConfigRoute = async (c: CtxWithJson<typeof searchConfigSchema>) => {
  const result = await testSearchConfigConnection(normalizeSearchConfig(c.req.valid('json')));
  return c.json(result, result.ok ? 200 : 400);
};
