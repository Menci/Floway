import type { Context } from 'hono';

import { loadCodexUltraConfig, saveCodexUltraConfig } from '../../data-plane/codex/ultra-config.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import type { codexUltraConfigSchema } from '../schemas.ts';

export const getCodexUltraConfigRoute = async (c: Context) => c.json(await loadCodexUltraConfig());

export const putCodexUltraConfigRoute = async (c: CtxWithJson<typeof codexUltraConfigSchema>) => {
  const config = await saveCodexUltraConfig(c.req.valid('json'));
  return c.json(config);
};
