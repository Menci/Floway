// The only place that knows Agent Setup leases live in the gateway repository
// and that the authenticated user comes from auth middleware. Everything else
// about the feature — schema, rendering, lifecycle, route shape — belongs to
// @floway-dev/agent-setup; this module injects the gateway's persistence and
// identity into the package's route factories.
//
// The repository is threaded through a lazy adapter so the singleton repo is
// resolved per request (via getRepo()), not at module-load time.

import { type AuthVars, userFromContext } from '../middleware/auth.ts';
import { getRepo } from '../repo/index.ts';
import {
  type AgentSetupRepository,
  createAgentSetupControlRoutes,
  createAgentSetupPublicRoutes,
} from '@floway-dev/agent-setup';

export const AGENT_SETUP_ROUTE_PATH = '/api/setup';

const repository: AgentSetupRepository = {
  findByToken: token => getRepo().agentSetup.findByToken(token),
  latestByUserId: userId => getRepo().agentSetup.latestByUserId(userId),
  insertForUser: input => getRepo().agentSetup.insertForUser(input),
  updateConfiguration: input => getRepo().agentSetup.updateConfiguration(input),
  renewLease: input => getRepo().agentSetup.renewLease(input),
};

// Public GET/HEAD script routes. app.ts owns where they mount; here we only
// wire the lease store, owner lookup, and servable API-key resolution.
export const agentSetupPublicRoutes = createAgentSetupPublicRoutes({
  repository,
  userExists: async userId => (await getRepo().users.getById(userId)) !== null,
  resolveApiKey: async (userId, apiKeyId) => {
    const key = await getRepo().apiKeys.getById(apiKeyId);
    return key?.userId === userId ? { name: key.name, secret: key.key } : null;
  },
});

// Authenticated routes mounted inside the control plane behind auth.
export const agentSetupControlRoutes = createAgentSetupControlRoutes<{ Variables: AuthVars }>({
  repository,
  publicScriptBasePath: AGENT_SETUP_ROUTE_PATH,
  getUserId: c => userFromContext(c).id,
  listSelectableApiKeyIds: async userId => (await getRepo().apiKeys.listByUserId(userId)).map(key => key.id),
});
