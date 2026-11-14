import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { siteSettingsBody } from '../schemas.ts';

// Public by design: the sign-in page and its document title carry the site name
// before any credential exists, so this read cannot sit behind the admin gate
// that owns the write.
export const getSiteSettings = async (c: AuthedContext) => {
  const settings = await getRepo().siteSettings.get();
  return c.json({ site_name: settings.siteName });
};

export const putSiteSettings = async (c: CtxWithJson<typeof siteSettingsBody>) => {
  const { site_name } = c.req.valid('json');
  await getRepo().siteSettings.save({ siteName: site_name });
  return c.json({ site_name });
};
