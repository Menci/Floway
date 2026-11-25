import { getProviderRepo, type ProviderRepo } from '@floway-dev/provider';
import { createChatGPTService, type ChatGPTServices } from '@floway-dev/provider-chatgpt';
import { createClaudeCodeService, type ClaudeCodeServices } from '@floway-dev/provider-claude-code';
import { createCopilotService, type CopilotServices } from '@floway-dev/provider-copilot';
import { createKimiCodeService, type KimiCodeServices } from '@floway-dev/provider-kimi-code';
import { createOllamaService, type OllamaServices } from '@floway-dev/provider-ollama';

export type GatewayProviderServices = Pick<
  ChatGPTServices & ClaudeCodeServices & CopilotServices & KimiCodeServices & OllamaServices,
  'chatgpt' | 'claudeCode' | 'copilot' | 'kimiCode' | 'ollama'
>;

let services: GatewayProviderServices | undefined;

export const initGatewayProviderServices = (): void => {
  if (services !== undefined) return;
  // The host can rebind its repository for each event in the same isolate.
  const repo: ProviderRepo = {
    upstreams: {
      getById: id => getProviderRepo().upstreams.getById(id),
      saveState: (id, mutate) => getProviderRepo().upstreams.saveState(id, mutate),
    },
    recordUpstreamMetric: (...args) => getProviderRepo().recordUpstreamMetric(...args),
  };
  services = Object.freeze({
    chatgpt: createChatGPTService(),
    claudeCode: createClaudeCodeService(repo),
    copilot: createCopilotService(),
    kimiCode: createKimiCodeService(),
    ollama: createOllamaService(repo),
  });
};

export const getGatewayProviderServices = (): GatewayProviderServices => {
  if (services === undefined) throw new Error('Gateway provider services have not been initialized');
  return services;
};
