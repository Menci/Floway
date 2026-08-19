import { OAuth2ProtocolError } from './oauth2-protocol-error.ts';
import type { OAuth2AccessPolicy } from '../../repo/types.ts';
import { getFetch } from '@floway-dev/platform';

type GiteaAccessPolicy = Extract<OAuth2AccessPolicy, { type: 'gitea' }>;

// Gitea registers these current-user endpoints under the user and organization
// token-scope categories.
// https://github.com/go-gitea/gitea/blob/c121f02a7e7efa25d2a59e26414fbe2c9486457d/routers/api/v1/api.go#L1268-L1273
// https://github.com/go-gitea/gitea/blob/c121f02a7e7efa25d2a59e26414fbe2c9486457d/routers/api/v1/api.go#L1788-L1793
const GITEA_ORGANIZATIONS_PATH = '/api/v1/user/orgs';
const GITEA_TEAMS_PATH = '/api/v1/user/teams';
const PAGE_SIZE = 100;
const MAX_RESPONSE_LENGTH = 1024 * 1024;

type JsonObject = Record<string, unknown>;

const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const stringField = (value: JsonObject, field: string): string | null =>
  typeof value[field] === 'string' ? value[field] : null;

const collectionEndpoint = (policy: GiteaAccessPolicy, path: string): URL =>
  new URL(`${policy.baseUrl.replace(/\/+$/, '')}${path}`);

const pageMatches = async (
  endpoint: URL,
  accessToken: string,
  signal: AbortSignal,
  matches: (item: JsonObject) => boolean,
): Promise<boolean> => {
  for (let page = 1; ; page++) {
    const url = new URL(endpoint);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(PAGE_SIZE));

    let response: Response;
    try {
      response = await getFetch()(url.toString(), {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        signal,
      });
    } catch (cause) {
      throw new OAuth2ProtocolError('Gitea membership request failed', { cause });
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_LENGTH) {
      throw new OAuth2ProtocolError('Gitea membership response exceeded 1 MiB');
    }
    if (!response.ok) {
      throw new OAuth2ProtocolError(`Gitea membership request failed (${response.status})`);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new OAuth2ProtocolError('Gitea membership endpoint returned malformed JSON', { cause });
    }
    if (!Array.isArray(value) || value.some(item => typeof item !== 'object' || item === null || Array.isArray(item))) {
      throw new OAuth2ProtocolError('Gitea membership endpoint returned a non-object collection');
    }
    const items = value as JsonObject[];
    if (items.some(matches)) return true;
    if (items.length < PAGE_SIZE) return false;
  }
};

// Organization exposes name plus the deprecated username alias; Team exposes
// name and its owning organization.
// https://github.com/go-gitea/gitea/blob/c121f02a7e7efa25d2a59e26414fbe2c9486457d/modules/structs/org.go#L7-L31
// https://github.com/go-gitea/gitea/blob/c121f02a7e7efa25d2a59e26414fbe2c9486457d/modules/structs/org_team.go#L20-L29
const organizationMatches = (organization: JsonObject, allowed: readonly string[]): boolean =>
  ['name', 'username']
    .map(field => stringField(organization, field))
    .filter((name): name is string => name !== null)
    .some(name => allowed.some(candidate => sameName(candidate, name)));

const teamMatches = (team: JsonObject, allowed: ReadonlyArray<readonly [string, string]>): boolean => {
  const name = stringField(team, 'name');
  const organization = team.organization;
  if (name === null || typeof organization !== 'object' || organization === null || Array.isArray(organization)) return false;
  return allowed.some(([organizationName, teamName]) =>
    sameName(teamName, name) && organizationMatches(organization as JsonObject, [organizationName]));
};

export const validateGiteaAccess = async (
  policy: GiteaAccessPolicy,
  accessToken: string,
  signal: AbortSignal,
): Promise<void> => {
  const organizations: string[] = [];
  const teams: Array<readonly [string, string]> = [];
  for (const membership of policy.allowedMemberships) {
    const separator = membership.indexOf(':');
    if (separator === -1) organizations.push(membership);
    else teams.push([membership.slice(0, separator), membership.slice(separator + 1)]);
  }

  const checks: Array<Promise<boolean>> = [];
  if (organizations.length > 0) {
    checks.push(pageMatches(
      collectionEndpoint(policy, GITEA_ORGANIZATIONS_PATH),
      accessToken,
      signal,
      organization => organizationMatches(organization, organizations),
    ));
  }
  if (teams.length > 0) {
    checks.push(pageMatches(
      collectionEndpoint(policy, GITEA_TEAMS_PATH),
      accessToken,
      signal,
      team => teamMatches(team, teams),
    ));
  }
  if (!(await Promise.all(checks)).some(Boolean)) {
    throw new OAuth2ProtocolError('This OAuth2 account does not belong to an allowed Gitea organization or team');
  }
};
