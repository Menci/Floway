import { api, callApi, type ApiResult } from './client';

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
  viaApiKey: boolean;
  apiKey: { id: string; name: string } | null;
}

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi(() => api.auth.me.$get());

export const login = (body: { username: string; password: string }) =>
  callApi(() => api.auth.login.$post({ json: body }));

export const changeOwnPassword = (body: { currentPassword: string; newPassword: string }) =>
  callApi(() => api.api.users.me.password.$patch({ json: body }));
