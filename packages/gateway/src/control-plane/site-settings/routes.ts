import type { Context } from 'hono';

import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { siteSettingsBody } from '../schemas.ts';

export const getSiteSettings = async (c: Context) => c.json(await getRepo().siteSettings.get());

export const putSiteSettings = async (c: CtxWithJson<typeof siteSettingsBody>) => {
  const settings = c.req.valid('json');
  await getRepo().siteSettings.save(settings);
  return c.json(settings);
};
