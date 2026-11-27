// GitHub Enterprise Cloud with data residency assigns each enterprise one
// SUBDOMAIN.ghe.com tenant root, while its REST API lives at
// api.SUBDOMAIN.ghe.com. The configured value is the tenant root itself.
// https://github.com/github/docs/blob/d19b6951e376efb7bd26fd1c0369158d1641d139/content/admin/data-residency/about-github-enterprise-cloud-with-data-residency.md#L96-L104
export const GITHUB_DOTCOM_HOST = 'github.com';

const GHE_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/;

export const normalizeGitHubHost = (value: string): string => {
  const host = value.trim().toLowerCase();
  if (host === GITHUB_DOTCOM_HOST || GHE_TENANT_HOST.test(host)) return host;
  throw new Error('GitHub host must be github.com or a tenant hostname ending in .ghe.com');
};

export const githubWebOrigin = (host: string): string => `https://${normalizeGitHubHost(host)}`;

export const githubApiOrigin = (host: string): string => {
  const normalized = normalizeGitHubHost(host);
  return normalized === GITHUB_DOTCOM_HOST
    ? 'https://api.github.com'
    : `https://api.${normalized}`;
};
