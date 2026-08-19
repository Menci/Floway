import type { InferResponseType } from 'hono/client';

import { api, callApi, type ApiResult } from './client';

type MeResponse = InferResponseType<typeof api.auth.me.$get, 200>;
export type LoginResponse = InferResponseType<typeof api.auth.login.$post, 200>;
export type OAuth2ProvidersResponse = InferResponseType<typeof api.auth.oauth2.providers.$get, 200>;
export type OAuth2ResultResponse = InferResponseType<typeof api.auth.oauth2.result.$post, 200>;
export type OAuth2RegistrationResponse = InferResponseType<typeof api.auth.oauth2.register.$post, 201>;
type ChangeOwnPasswordResponse = InferResponseType<typeof api.api.users.me.password.$patch, 200>;
export type AuthUser = MeResponse['user'];

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi(() => api.auth.me.$get());

export const login = (body: { username: string; password: string }): Promise<ApiResult<LoginResponse>> =>
  callApi(() => api.auth.login.$post({ json: body }));

export const listOAuth2Providers = (): Promise<ApiResult<OAuth2ProvidersResponse>> =>
  callApi(() => api.auth.oauth2.providers.$get());

export const resolveOAuth2Result = (token: string): Promise<ApiResult<OAuth2ResultResponse>> =>
  callApi(() => api.auth.oauth2.result.$post({ json: { token } }));

export const registerOAuth2User = (body: { registrationToken: string; username: string }): Promise<ApiResult<OAuth2RegistrationResponse>> =>
  callApi(() => api.auth.oauth2.register.$post({ json: body }));

export const changeOwnPassword = (body: { currentPassword: string; newPassword: string }): Promise<ApiResult<ChangeOwnPasswordResponse>> =>
  callApi(() => api.api.users.me.password.$patch({ json: body }));
