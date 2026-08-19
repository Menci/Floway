import { z } from 'zod';

import { getEnvOptional } from '@floway-dev/platform';

const nonEmpty = z.string().trim().min(1);
const endpoint = nonEmpty.transform(value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`OAuth2 endpoint must use http or https: ${value}`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`OAuth2 endpoint must not contain credentials or a fragment: ${value}`);
  }
  return url.toString();
});

const providerSchema = z.object({
  id: nonEmpty.regex(/^[A-Za-z0-9_-]+$/),
  displayName: nonEmpty,
  clientId: nonEmpty,
  clientSecret: nonEmpty,
  authorizationEndpoint: endpoint,
  tokenEndpoint: endpoint,
  userInfoEndpoint: endpoint,
  scopes: z.array(nonEmpty).default([]),
  clientAuthentication: z.enum(['client_secret_post', 'client_secret_basic']).default('client_secret_post'),
  userIdClaim: nonEmpty.optional(),
  usernameClaim: nonEmpty.optional(),
  authorizationParams: z.record(z.string(), z.string()).default({}),
}).strict().superRefine((provider, context) => {
  const reserved = new Set(['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state']);
  for (const key of Object.keys(provider.authorizationParams)) {
    if (reserved.has(key)) {
      context.addIssue({
        code: 'custom',
        message: `authorizationParams must not override ${key}`,
        path: ['authorizationParams', key],
      });
    }
  }
});

export type OAuth2ProviderConfig = z.infer<typeof providerSchema>;

export interface OAuth2Config {
  publicBaseUrl: string | null;
  providers: OAuth2ProviderConfig[];
}

const validationMessage = (cause: unknown): string => {
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    return `${issue.path.join('.') || 'value'}: ${issue.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
};

const parseProviders = (raw: string): OAuth2ProviderConfig[] => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error('OAUTH2_PROVIDERS must be valid JSON', { cause });
  }
  let providers: OAuth2ProviderConfig[];
  try {
    providers = z.array(providerSchema).parse(value);
  } catch (cause) {
    throw new Error(`OAUTH2_PROVIDERS is invalid: ${validationMessage(cause)}`, { cause });
  }
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`OAUTH2_PROVIDERS contains duplicate id '${provider.id}'`);
    ids.add(provider.id);
  }
  return providers;
};

const parsePublicBaseUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new Error('OAUTH2_PUBLIC_BASE_URL must be an absolute URL', { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OAUTH2_PUBLIC_BASE_URL must use http or https');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OAUTH2_PUBLIC_BASE_URL must be an origin without credentials, a path, a query, or a fragment');
  }
  return url.origin;
};

export const getOAuth2Config = (): OAuth2Config => {
  const rawProviders = getEnvOptional('OAUTH2_PROVIDERS', '').trim();
  if (rawProviders === '') return { publicBaseUrl: null, providers: [] };
  const providers = parseProviders(rawProviders);
  if (providers.length === 0) return { publicBaseUrl: null, providers: [] };

  const rawPublicBaseUrl = getEnvOptional('OAUTH2_PUBLIC_BASE_URL', '').trim();
  if (rawPublicBaseUrl === '') {
    throw new Error('OAUTH2_PUBLIC_BASE_URL is required when OAUTH2_PROVIDERS contains a provider');
  }
  return { publicBaseUrl: parsePublicBaseUrl(rawPublicBaseUrl), providers };
};

export const oauth2ProviderById = (config: OAuth2Config, id: string): OAuth2ProviderConfig | null =>
  config.providers.find(provider => provider.id === id) ?? null;

export const oauth2CallbackUrl = (config: OAuth2Config, provider: OAuth2ProviderConfig): string => {
  if (config.publicBaseUrl === null) throw new Error('OAuth2 callback URL requested without an OAuth2 public base URL');
  return `${config.publicBaseUrl}/auth/oauth2/${encodeURIComponent(provider.id)}/callback`;
};

export const oauth2FrontendRedirect = (config: OAuth2Config, fragment: URLSearchParams): string => {
  if (config.publicBaseUrl === null) throw new Error('OAuth2 frontend redirect requested without an OAuth2 public base URL');
  return `${config.publicBaseUrl}/#${fragment.toString()}`;
};
