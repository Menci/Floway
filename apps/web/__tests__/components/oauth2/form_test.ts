import { describe, expect, it } from 'vitest';

import { oauth2ProviderBody, oauth2ProviderFormDefaults, oauth2ProviderFormSchema } from '../../../src/components/oauth2/form';

const valid = {
  id: 'custom',
  displayName: 'Example ID',
  enabled: true,
  clientId: 'floway-client',
  clientSecret: 'floway-secret',
  authorizationEndpoint: 'https://id.example.com/oauth/authorize',
  tokenEndpoint: 'https://id.example.com/oauth/token',
  userInfoEndpoint: 'https://id.example.com/api/user',
  scopes: 'openid profile email',
  clientAuthentication: 'client_secret_post' as const,
  userIdClaim: '',
  usernameClaim: 'data.login',
  authorizationParams: '{"prompt":"login"}',
  accessPolicy: 'allow_all' as const,
  giteaBaseUrl: '',
  giteaAllowedMemberships: '',
};

describe('OAuth2 provider form', () => {
  it('serializes the operator-facing text fields to the API wire shape', () => {
    expect(oauth2ProviderBody(valid)).toEqual({
      display_name: 'Example ID',
      enabled: true,
      client_id: 'floway-client',
      authorization_endpoint: 'https://id.example.com/oauth/authorize',
      token_endpoint: 'https://id.example.com/oauth/token',
      userinfo_endpoint: 'https://id.example.com/api/user',
      scopes: ['openid', 'profile', 'email'],
      client_authentication: 'client_secret_post',
      user_id_claim: null,
      username_claim: 'data.login',
      authorization_params: { prompt: 'login' },
      access_policy: { type: 'allow_all' },
    });
  });

  it('requires a secret only when creating and rejects reserved authorization parameters', () => {
    expect(oauth2ProviderFormSchema('create').safeParse({ ...valid, clientSecret: '' }).success).toBe(false);
    expect(oauth2ProviderFormSchema('edit').safeParse({ ...valid, clientSecret: '' }).success).toBe(true);
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...valid,
      authorizationParams: '{"state":"operator-value"}',
    }).success).toBe(false);
  });

  it('never hydrates a stored client secret back into the edit form', () => {
    const defaults = oauth2ProviderFormDefaults({
      id: 'custom',
      display_name: 'Example ID',
      enabled: true,
      client_id: 'floway-client',
      client_secret_configured: true,
      authorization_endpoint: valid.authorizationEndpoint,
      token_endpoint: valid.tokenEndpoint,
      userinfo_endpoint: valid.userInfoEndpoint,
      scopes: ['openid'],
      client_authentication: 'client_secret_post',
      user_id_claim: null,
      username_claim: null,
      authorization_params: {},
      access_policy: { type: 'allow_all' },
      created_at: '2026-08-19T00:00:00.000Z',
      updated_at: '2026-08-19T00:00:00.000Z',
    });

    expect(defaults.clientSecret).toBe('');
  });

  it('serializes and validates Gitea organization and team access', () => {
    const gitea = {
      ...valid,
      scopes: 'read:user read:organization',
      accessPolicy: 'gitea' as const,
      giteaBaseUrl: 'https://gitea.example.com',
      giteaAllowedMemberships: 'company:owners\nother-company',
    };
    expect(oauth2ProviderFormSchema('create').safeParse(gitea).success).toBe(true);
    expect(oauth2ProviderBody(gitea).access_policy).toEqual({
      type: 'gitea',
      base_url: 'https://gitea.example.com',
      allowed_memberships: ['company:owners', 'other-company'],
    });
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...gitea,
      scopes: 'read:user',
    }).success).toBe(false);
  });
});
