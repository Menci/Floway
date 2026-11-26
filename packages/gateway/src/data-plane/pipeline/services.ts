import { createPerRequestProviderFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, StoredUpstreamRecord } from '../../repo/types.ts';
import { createOpenAIResponsesHttpStore, type OpenAIResponsesStatefulStore } from '../chat/openai-responses/items/store.ts';
import { AffinityCodec } from '../chat/shared/affinity/carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from '../chat/shared/affinity/legacy.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from '../chat/shared/sidecar-codec.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { createLocalWebSearchService, type LocalWebSearchService } from '../tools/web-search/pipeline.ts';
import type { ProviderRepo, ProviderServices } from '@floway-dev/provider';
import { createChatGPTService, type ChatGPTServices } from '@floway-dev/provider-chatgpt';
import { createClaudeCodeService, type ClaudeCodeServices } from '@floway-dev/provider-claude-code';
import { createCopilotService, type CopilotServices } from '@floway-dev/provider-copilot';
import { createKimiCodeService, type KimiCodeServices } from '@floway-dev/provider-kimi-code';
import { createOllamaService, type OllamaServices } from '@floway-dev/provider-ollama';

type ProviderServicesByKind = ChatGPTServices & ClaudeCodeServices & CopilotServices & KimiCodeServices & OllamaServices;
type ProcessServices = Omit<ProviderServicesByKind, keyof ProviderServices> & { providerRepo: ProviderRepo };

export type GatewayServices = ProviderServicesByKind & {
  affinity: AffinityCodec;
  sidecarCodec: SidecarCodecFactory;
  openaiResponsesStore: (startedAt: number, store: boolean | undefined) => OpenAIResponsesStatefulStore;
  localWebSearch: LocalWebSearchService;
  catalogCandidates(options: Parameters<typeof enumerateModelCandidates>[0]): ReturnType<typeof enumerateModelCandidates>;
};

let processServices: ProcessServices | undefined;

export const initProviderServices = (providerRepo: ProviderRepo): void => {
  processServices = Object.freeze({
    providerRepo,
    chatgpt: createChatGPTService(),
    claudeCode: createClaudeCodeService(providerRepo),
    copilot: createCopilotService(),
    kimiCode: createKimiCodeService(),
    ollama: createOllamaService(),
  });
};

export const getProviderServices = (): ProcessServices => {
  if (!processServices) throw new Error('Provider services have not been initialized');
  return processServices;
};

export const createGatewayServices = async (
  runtimeLocation: string,
  apiKey: Pick<ApiKey, 'id' | 'serverSecret' | 'openaiResponsesRetentionSeconds'>,
  upstreams?: readonly StoredUpstreamRecord[],
): Promise<GatewayServices> => {
  const { providerRepo: _providerRepo, ...services } = getProviderServices();
  const { id, serverSecret, openaiResponsesRetentionSeconds } = apiKey;
  const snapshot = upstreams ?? await getRepo().upstreams.list();
  return {
    ...services,
    fetcher: await createPerRequestProviderFetcher(runtimeLocation, snapshot),
    catalogCandidates: options => enumerateModelCandidates(options, snapshot),
    affinity: new AffinityCodec(serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity),
    sidecarCodec: createSidecarCodecFactory(serverSecret),
    openaiResponsesStore: (startedAt, store) => createOpenAIResponsesHttpStore({ id, openaiResponsesRetentionSeconds }, startedAt, store),
    localWebSearch: createLocalWebSearchService(),
  };
};
