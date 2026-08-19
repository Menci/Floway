import type { InferResponseType } from 'hono/client';

import { api, callApi, type ApiResult } from './client';

export type SiteSettings = InferResponseType<typeof api.api['site-settings']['$get'], 200>;
type UpdateSiteSettingsResponse = InferResponseType<typeof api.api['site-settings']['$put'], 200>;

export const getSiteSettings = (): Promise<ApiResult<SiteSettings>> =>
  callApi(() => api.api['site-settings'].$get());

export const updateSiteSettings = (settings: SiteSettings): Promise<ApiResult<UpdateSiteSettingsResponse>> =>
  callApi(() => api.api['site-settings'].$put({ json: settings }));
