import { z } from 'zod';

import type { OAuth2Provider } from '../../api/types';

export type OAuth2ClientAuthentication = 'client_secret_post' | 'client_secret_basic';

export interface OAuth2ProviderFormValues {
  id: string;
  displayName: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  scopes: string;
  clientAuthentication: OAuth2ClientAuthentication;
  userIdClaim: string;
  usernameClaim: string;
  authorizationParams: string;
}

const RESERVED_AUTHORIZATION_PARAMS = new Set([
  'client_id',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
]);

const parseEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const parseAuthorizationParams = (raw: string): Record<string, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('dashboard.oauth2.validation.authorizationParamsJson', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.values(parsed).some(value => typeof value !== 'string')) {
    throw new TypeError('dashboard.oauth2.validation.authorizationParamsShape');
  }
  const reserved = Object.keys(parsed).find(key => RESERVED_AUTHORIZATION_PARAMS.has(key));
  if (reserved !== undefined) throw new Error('dashboard.oauth2.validation.authorizationParamsReserved');
  return parsed as Record<string, string>;
};

const required = (message: string) => z.string().trim().min(1, message);

export const oauth2ProviderFormSchema = (mode: 'create' | 'edit') => z.object({
  id: required('dashboard.oauth2.validation.required')
    .max(64, 'dashboard.oauth2.validation.id')
    .regex(/^[A-Za-z0-9_-]+$/, 'dashboard.oauth2.validation.id'),
  displayName: required('dashboard.oauth2.validation.required').max(200, 'dashboard.oauth2.validation.maximum'),
  enabled: z.boolean(),
  clientId: required('dashboard.oauth2.validation.required').max(4096, 'dashboard.oauth2.validation.maximum'),
  clientSecret: z.string().max(4096, 'dashboard.oauth2.validation.maximum'),
  authorizationEndpoint: required('dashboard.oauth2.validation.required').refine(parseEndpoint, 'dashboard.oauth2.validation.endpoint'),
  tokenEndpoint: required('dashboard.oauth2.validation.required').refine(parseEndpoint, 'dashboard.oauth2.validation.endpoint'),
  userInfoEndpoint: required('dashboard.oauth2.validation.required').refine(parseEndpoint, 'dashboard.oauth2.validation.endpoint'),
  scopes: z.string(),
  clientAuthentication: z.enum(['client_secret_post', 'client_secret_basic']),
  userIdClaim: z.string().max(200, 'dashboard.oauth2.validation.maximum'),
  usernameClaim: z.string().max(200, 'dashboard.oauth2.validation.maximum'),
  authorizationParams: z.string().superRefine((value, ctx) => {
    try {
      parseAuthorizationParams(value);
    } catch (cause) {
      ctx.addIssue({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }),
}).superRefine((value, ctx) => {
  if (mode === 'create' && value.clientSecret.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'dashboard.oauth2.validation.required', path: ['clientSecret'] });
  }
});

export const oauth2ProviderFormDefaults = (provider: OAuth2Provider | null): OAuth2ProviderFormValues => ({
  id: provider?.id ?? '',
  displayName: provider?.display_name ?? '',
  enabled: provider?.enabled ?? true,
  clientId: provider?.client_id ?? '',
  clientSecret: '',
  authorizationEndpoint: provider?.authorization_endpoint ?? '',
  tokenEndpoint: provider?.token_endpoint ?? '',
  userInfoEndpoint: provider?.userinfo_endpoint ?? '',
  scopes: provider?.scopes.join(' ') ?? '',
  clientAuthentication: provider?.client_authentication ?? 'client_secret_post',
  userIdClaim: provider?.user_id_claim ?? '',
  usernameClaim: provider?.username_claim ?? '',
  authorizationParams: JSON.stringify(provider?.authorization_params ?? {}, null, 2),
});

export const oauth2ProviderBody = (values: OAuth2ProviderFormValues) => ({
  display_name: values.displayName.trim(),
  enabled: values.enabled,
  client_id: values.clientId.trim(),
  authorization_endpoint: values.authorizationEndpoint.trim(),
  token_endpoint: values.tokenEndpoint.trim(),
  userinfo_endpoint: values.userInfoEndpoint.trim(),
  scopes: values.scopes.trim() === '' ? [] : values.scopes.trim().split(/\s+/),
  client_authentication: values.clientAuthentication,
  user_id_claim: values.userIdClaim.trim() || null,
  username_claim: values.usernameClaim.trim() || null,
  authorization_params: parseAuthorizationParams(values.authorizationParams),
});
