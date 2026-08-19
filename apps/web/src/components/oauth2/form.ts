import { z } from 'zod';

import type { OAuth2Provider } from '../../api/types';

export type OAuth2ClientAuthentication = 'client_secret_post' | 'client_secret_basic';
type OAuth2AccessValue = string | number | boolean | null | Array<string | number | boolean | null>;
type OAuth2AccessCondition = {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'not_contains';
  value: OAuth2AccessValue;
} | {
  field: string;
  op: 'exists' | 'not_exists';
};
interface OAuth2AccessPolicy {
  logic: 'and' | 'or';
  conditions: OAuth2AccessCondition[];
}

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
  accessPolicy: string;
  accessDeniedMessage: string;
  registrationUpstreamOverride: boolean;
  registrationUpstreamIds: string[];
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

const accessPolicyScalar = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
const accessPolicyValue = z.union([accessPolicyScalar, z.array(accessPolicyScalar).max(100)]);
const accessPolicyField = z.string().trim().min(1).max(200);
const valueAccessCondition = z.object({
  field: accessPolicyField,
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'not_contains']),
  value: accessPolicyValue,
}).strict().superRefine((condition, context) => {
  if ((condition.op === 'gt' || condition.op === 'gte' || condition.op === 'lt' || condition.op === 'lte')
    && typeof condition.value !== 'number' && typeof condition.value !== 'string') {
    context.addIssue({ code: 'custom', message: 'dashboard.oauth2.validation.accessPolicyShape', path: ['value'] });
  }
  if ((condition.op === 'in' || condition.op === 'not_in') && !Array.isArray(condition.value)) {
    context.addIssue({ code: 'custom', message: 'dashboard.oauth2.validation.accessPolicyShape', path: ['value'] });
  }
});
const presenceAccessCondition = z.object({
  field: accessPolicyField,
  op: z.enum(['exists', 'not_exists']),
}).strict();
const accessPolicySchema = z.object({
  logic: z.enum(['and', 'or']),
  conditions: z.array(z.union([valueAccessCondition, presenceAccessCondition])).max(100),
}).strict();

const allowAllAccessPolicy: OAuth2AccessPolicy = { logic: 'and', conditions: [] };

export const parseAccessPolicy = (raw: string): OAuth2AccessPolicy => {
  if (raw.trim() === '') return allowAllAccessPolicy;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('dashboard.oauth2.validation.accessPolicyJson', { cause });
  }
  const result = accessPolicySchema.safeParse(parsed);
  if (!result.success) throw new TypeError('dashboard.oauth2.validation.accessPolicyShape');
  return result.data;
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
  accessPolicy: z.string().superRefine((value, ctx) => {
    try {
      parseAccessPolicy(value);
    } catch (cause) {
      ctx.addIssue({ code: 'custom', message: cause instanceof Error ? cause.message : String(cause) });
    }
  }),
  accessDeniedMessage: z.string().max(2000, 'dashboard.oauth2.validation.maximum'),
  registrationUpstreamOverride: z.boolean(),
  registrationUpstreamIds: z.array(z.string()),
}).superRefine((value, ctx) => {
  if (mode === 'create' && value.clientSecret.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'dashboard.oauth2.validation.required', path: ['clientSecret'] });
  }
  if (value.registrationUpstreamOverride && value.registrationUpstreamIds.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamAccess.validation', path: ['registrationUpstreamIds'] });
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
  accessPolicy: provider === null
    || (provider.access_policy.logic === 'and' && provider.access_policy.conditions.length === 0)
    ? ''
    : JSON.stringify(provider.access_policy, null, 2),
  accessDeniedMessage: provider?.access_denied_message ?? '',
  registrationUpstreamOverride: provider?.registration_upstream_ids !== null
    && provider?.registration_upstream_ids !== undefined,
  registrationUpstreamIds: provider?.registration_upstream_ids ?? [],
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
  access_policy: parseAccessPolicy(values.accessPolicy),
  access_denied_message: values.accessDeniedMessage,
  registration_upstream_ids: values.registrationUpstreamOverride ? values.registrationUpstreamIds : null,
});
