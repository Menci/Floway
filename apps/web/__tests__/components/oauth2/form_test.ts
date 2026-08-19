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
  accessPolicy: '',
  accessDeniedMessage: 'Denied by {{provider}}: {{field}} {{op}} {{required}}; roles={{current.roles}}',
  registrationUpstreamOverride: true,
  registrationUpstreamIds: ['up_allowed'],
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
      access_policy: { logic: 'and', conditions: [] },
      access_denied_message: valid.accessDeniedMessage,
      registration_upstream_ids: ['up_allowed'],
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
      access_policy: { logic: 'and', conditions: [] },
      access_denied_message: '',
      registration_upstream_ids: null,
      created_at: '2026-08-19T00:00:00.000Z',
      updated_at: '2026-08-19T00:00:00.000Z',
    });

    expect(defaults.clientSecret).toBe('');
    expect(defaults.accessPolicy).toBe('');
    expect(defaults.registrationUpstreamOverride).toBe(false);
  });

  it('serializes and validates a UserInfo claim access policy', () => {
    const restricted = {
      ...valid,
      scopes: 'openid groups',
      accessPolicy: JSON.stringify({
        logic: 'or',
        conditions: [
          { field: 'groups', op: 'contains', value: 'POPIPA-l10n:owners' },
          { field: 'age', op: 'gte', value: 18 },
          { field: 'role', op: 'in', value: ['owner', 'operator'] },
          { field: 'suspended', op: 'not_exists' },
        ],
      }),
    };
    expect(oauth2ProviderFormSchema('create').safeParse(restricted).success).toBe(true);
    expect(oauth2ProviderBody(restricted).access_policy).toEqual({
      logic: 'or',
      conditions: [
        { field: 'groups', op: 'contains', value: 'POPIPA-l10n:owners' },
        { field: 'age', op: 'gte', value: 18 },
        { field: 'role', op: 'in', value: ['owner', 'operator'] },
        { field: 'suspended', op: 'not_exists' },
      ],
    });
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...restricted,
      accessPolicy: '{"logic":"or","conditions":[{"field":"groups","op":"equals","value":"owners"}]}',
    }).success).toBe(false);
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...restricted,
      accessPolicy: '{"logic":"and","conditions":[{"field":"age","op":"gt","value":true}]}',
    }).success).toBe(false);
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...restricted,
      accessPolicy: '{"logic":"and","conditions":[{"field":"role","op":"in","value":"owner"}]}',
    }).success).toBe(false);
  });

  it('requires a non-empty upstream allowlist only while the self-registration override is enabled', () => {
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...valid,
      registrationUpstreamIds: [],
    }).success).toBe(false);
    expect(oauth2ProviderFormSchema('create').safeParse({
      ...valid,
      registrationUpstreamOverride: false,
      registrationUpstreamIds: [],
    }).success).toBe(true);
  });
});
