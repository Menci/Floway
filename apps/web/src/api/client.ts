import { hc } from 'hono/client';

import { authFetch, callApi, type ApiResult, type MeResponse } from './auth';
import type { AppType } from '@floway-dev/gateway/app-type';

// hc types the request — path, method and body come from the gateway's own
// route definitions, so a control-plane change breaks typecheck here instead
// of at runtime. It does not unwrap the response; callApi in ./auth still owns
// the { error } envelope, non-JSON bodies and the single 401 path.
const client = hc<AppType>('/', { fetch: authFetch });

export const api = client;

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi(() => api.auth.me.$get());

export const login = (body: { username: string; password: string }) =>
  callApi(() => api.auth.login.$post({ json: body }));

export const changeOwnPassword = (body: { currentPassword: string; newPassword: string }) =>
  callApi(() => api.api.users.me.password.$patch({ json: body }));
