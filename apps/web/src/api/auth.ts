import type { InferResponseType } from 'hono/client';

import { api, callApi, type ApiResult } from './client';

type MeResponse = InferResponseType<typeof api.auth.me.$get, 200>;
export type LoginResponse = InferResponseType<typeof api.auth.login.$post, 200>;
type ChangeOwnPasswordResponse = InferResponseType<typeof api.api.users.me.password.$patch, 200>;
export type AuthUser = MeResponse['user'];

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi(() => api.auth.me.$get());

export const login = (body: { username: string; password: string }): Promise<ApiResult<LoginResponse>> =>
  callApi(() => api.auth.login.$post({ json: body }));

export const changeOwnPassword = (body: { currentPassword: string; newPassword: string }): Promise<ApiResult<ChangeOwnPasswordResponse>> =>
  callApi(() => api.api.users.me.password.$patch({ json: body }));
