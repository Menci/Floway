// Public surface of @floway-dev/agent-setup. A host application wires the two
// route factories to its persistence and auth; everything else here supports
// implementing the repository contract and typing the configuration.

export { type AgentSetupConfiguration, agentSetupConfigurationSchema } from './configuration.ts';
export {
  type AgentSetupControlDeps,
  type AgentSetupPublicDeps,
  createAgentSetupControlRoutes,
  createAgentSetupPublicRoutes,
} from './routes.ts';
export {
  type AgentSetupMutation,
  type AgentSetupRecord,
  type AgentSetupRenewal,
  type AgentSetupRepository,
  AgentSetupTokenCollisionError,
} from './repository.ts';
