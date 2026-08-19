import { z } from 'zod';

import { getRepo } from '../../repo/index.ts';
import type { OAuth2Provider } from '../../repo/types.ts';

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

const giteaBaseUrl = nonEmpty.transform(value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Gitea base URL must use http or https: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Gitea base URL must not contain credentials, a query, or a fragment: ${value}`);
  }
  return url.toString().replace(/\/+$/, '');
});

const giteaMembership = nonEmpty.max(512).refine(value => {
  const parts = value.split(':');
  return parts.length <= 2 && parts.every(part => part.trim() !== '');
}, 'Gitea membership must be an organization or organization:team');

const accessPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('allow_all') }).strict(),
  z.object({
    type: z.literal('gitea'),
    baseUrl: giteaBaseUrl,
    allowedMemberships: z.array(giteaMembership).min(1).max(100),
  }).strict(),
]);

const providerSchema = z.object({
  id: nonEmpty.regex(/^[A-Za-z0-9_-]+$/),
  displayName: nonEmpty,
  enabled: z.boolean(),
  clientId: nonEmpty,
  clientSecret: nonEmpty,
  authorizationEndpoint: endpoint,
  tokenEndpoint: endpoint,
  userInfoEndpoint: endpoint,
  scopes: z.array(nonEmpty),
  clientAuthentication: z.enum(['client_secret_post', 'client_secret_basic']),
  userIdClaim: nonEmpty.nullable(),
  usernameClaim: nonEmpty.nullable(),
  authorizationParams: z.record(z.string(), z.string()),
  accessPolicy: accessPolicySchema,
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
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
  if (provider.accessPolicy.type === 'gitea') {
    const scopes = new Set(provider.scopes);
    for (const required of ['read:user', 'read:organization']) {
      if (!scopes.has(required)) {
        context.addIssue({
          code: 'custom',
          message: `Gitea access policy requires the ${required} scope`,
          path: ['scopes'],
        });
      }
    }
  }
});

export type OAuth2ProviderConfig = OAuth2Provider;

export interface OAuth2Config {
  publicBaseUrl: string | null;
  providers: OAuth2ProviderConfig[];
}

export const parseOAuth2Provider = (value: unknown): OAuth2ProviderConfig => providerSchema.parse(value);

export const parseOAuth2PublicBaseUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new Error('OAuth2 public base URL must be an absolute URL', { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OAuth2 public base URL must use http or https');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OAuth2 public base URL must be an origin without credentials, a path, a query, or a fragment');
  }
  return url.origin;
};

export const getOAuth2Config = async (): Promise<OAuth2Config> => {
  const repo = getRepo().oauth2Config;
  const [settings, storedProviders] = await Promise.all([repo.getSettings(), repo.listProviders()]);
  const providers = storedProviders.map(parseOAuth2Provider).filter(provider => provider.enabled);
  const publicBaseUrl = parseOAuth2PublicBaseUrl(settings.publicBaseUrl);
  // A provider may be prepared before the public origin is known. It becomes
  // visible atomically with that singleton setting rather than creating an
  // invalid intermediate state or requiring a cross-table transaction.
  return publicBaseUrl === ''
    ? { publicBaseUrl: null, providers: [] }
    : { publicBaseUrl, providers };
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

export const oauth2BindingFrontendRedirect = (config: OAuth2Config, fragment: URLSearchParams): string => {
  if (config.publicBaseUrl === null) throw new Error('OAuth2 binding redirect requested without an OAuth2 public base URL');
  return `${config.publicBaseUrl}/dashboard/settings#${fragment.toString()}`;
};
