import type { Context } from 'hono';
import { z } from 'zod';

import { parseOAuth2Provider, parseOAuth2PublicBaseUrl } from './oauth2-config.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { OAuth2Provider } from '../../repo/types.ts';
import type { createOAuth2ProviderBody, oauth2SettingsBody, updateOAuth2ProviderBody } from '../schemas.ts';

const providerToAdminWire = (provider: OAuth2Provider) => ({
  id: provider.id,
  display_name: provider.displayName,
  enabled: provider.enabled,
  client_id: provider.clientId,
  client_secret_configured: provider.clientSecret !== '',
  authorization_endpoint: provider.authorizationEndpoint,
  token_endpoint: provider.tokenEndpoint,
  userinfo_endpoint: provider.userInfoEndpoint,
  scopes: provider.scopes,
  client_authentication: provider.clientAuthentication,
  user_id_claim: provider.userIdClaim,
  username_claim: provider.usernameClaim,
  authorization_params: provider.authorizationParams,
  access_policy: provider.accessPolicy,
  created_at: provider.createdAt,
  updated_at: provider.updatedAt,
});

const validationMessage = (cause: unknown): string => {
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    return `${issue.path.join('.') || 'provider'}: ${issue.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
};

const validateProvider = (provider: OAuth2Provider): { provider: OAuth2Provider } | { error: string } => {
  try {
    return { provider: parseOAuth2Provider(provider) };
  } catch (cause) {
    return { error: validationMessage(cause) };
  }
};

const bodyToProvider = (
  id: string,
  body: z.infer<typeof createOAuth2ProviderBody> | z.infer<typeof updateOAuth2ProviderBody>,
  clientSecret: string,
  timestamps: { createdAt: string; updatedAt: string },
): OAuth2Provider => ({
  id,
  displayName: body.display_name,
  enabled: body.enabled,
  clientId: body.client_id,
  clientSecret,
  authorizationEndpoint: body.authorization_endpoint,
  tokenEndpoint: body.token_endpoint,
  userInfoEndpoint: body.userinfo_endpoint,
  scopes: body.scopes,
  clientAuthentication: body.client_authentication,
  userIdClaim: body.user_id_claim,
  usernameClaim: body.username_claim,
  authorizationParams: body.authorization_params,
  accessPolicy: body.access_policy,
  ...timestamps,
});

export const getOAuth2Settings = async (c: Context) => {
  const settings = await getRepo().oauth2Config.getSettings();
  return c.json({ public_base_url: settings.publicBaseUrl });
};

export const updateOAuth2Settings = async (c: CtxWithJson<typeof oauth2SettingsBody>) => {
  let publicBaseUrl: string;
  try {
    publicBaseUrl = parseOAuth2PublicBaseUrl(c.req.valid('json').public_base_url);
  } catch (cause) {
    return c.json({ error: validationMessage(cause) }, 400);
  }
  await getRepo().oauth2Config.saveSettings({
    publicBaseUrl,
    updatedAt: new Date().toISOString(),
  });
  return c.json({ public_base_url: publicBaseUrl });
};

export const listOAuth2AdminProviders = async (c: Context) => {
  const providers = await getRepo().oauth2Config.listProviders();
  return c.json(providers.map(providerToAdminWire));
};

export const createOAuth2Provider = async (c: CtxWithJson<typeof createOAuth2ProviderBody>) => {
  const body = c.req.valid('json');
  const now = new Date().toISOString();
  const parsed = validateProvider(bodyToProvider(body.id, body, body.client_secret, {
    createdAt: now,
    updatedAt: now,
  }));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  if (!(await getRepo().oauth2Config.insertProvider(parsed.provider))) {
    return c.json({ error: `OAuth2 provider ${body.id} already exists` }, 409);
  }
  return c.json(providerToAdminWire(parsed.provider), 201);
};

export const updateOAuth2Provider = async (c: CtxWithJson<typeof updateOAuth2ProviderBody>) => {
  const repo = getRepo().oauth2Config;
  const id = c.req.param('id') ?? '';
  const existing = await repo.getProviderById(id);
  if (!existing) return c.json({ error: 'OAuth2 provider not found' }, 404);

  const body = c.req.valid('json');
  const parsed = validateProvider(bodyToProvider(id, body, body.client_secret ?? existing.clientSecret, {
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }));
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  if (!(await repo.updateProvider(parsed.provider))) return c.json({ error: 'OAuth2 provider not found' }, 404);
  return c.json(providerToAdminWire(parsed.provider));
};

export const deleteOAuth2Provider = async (c: Context) => {
  await getRepo().oauth2Config.deleteProvider(c.req.param('id') ?? '');
  return c.body(null, 204);
};
