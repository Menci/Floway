import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertAzureUpstreamRecord, createAzureUpstream, type AzureDeploymentConfig } from '../../../shared/upstream/azure.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { isStreamingEndpoint, kindForEndpoints, publicPathsToModelEndpoints } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import type { ModelEndpoint } from '@copilot-gateway/protocols/common';

interface AzureProviderData {
  deployment: string;
}

const providerData = (model: UpstreamModel): AzureProviderData => model.providerData as AzureProviderData;

const publicModelId = (deployment: AzureDeploymentConfig): string => {
  const configured = deployment.publicModelId?.trim();
  return configured && configured.length > 0 ? configured : deployment.deployment;
};

const withMessagesCountTokens = (endpoints: readonly ModelEndpoint[]): ModelEndpoint[] =>
  endpoints.includes('messages') && !endpoints.includes('messages_count_tokens') ? [...endpoints, 'messages_count_tokens'] : [...endpoints];

const azureDeploymentEndpoints = (deployment: AzureDeploymentConfig): ModelEndpoint[] => withMessagesCountTokens(publicPathsToModelEndpoints(deployment.supportedEndpoints));

// Project an Azure deployment config row into the slim provider-neutral fields.
// kind/upstreamEndpoints/providerData/enabledFlags are added by the caller.
const azureInternalModel = (deployment: AzureDeploymentConfig): Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> = {
    id: publicModelId(deployment),
    limits: { ...(deployment.limits ?? {}) },
  };
  if (deployment.display_name !== undefined) internal.display_name = deployment.display_name;
  return internal;
};

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);
  const upstream = createAzureUpstream(azure);

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ProviderCallResult> => {
    const deployment = providerData(model).deployment;
    const requestBody = isStreamingEndpoint(endpoint) ? { ...body, stream: true, model: deployment } : { ...body, model: deployment };
    return upstream
      .fetch(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          signal,
        },
        extraHeaders ? { extraHeaders } : undefined,
      )
      .then(response => ({
        response,
        modelKey: deployment,
      }));
  };

  const provider: ModelProvider = {
    async getProvidedModels() {
      return azure.config.deployments.map(deployment => {
        const deploymentLayer = deployment.flagOverrides?.enabled ? deployment.flagOverrides.values : undefined;
        const effective = resolveEffectiveFlags(defaultsForProvider('azure'), [azure.flagOverrides, deploymentLayer]);
        const upstreamEndpoints = azureDeploymentEndpoints(deployment);
        return {
          ...azureInternalModel(deployment),
          kind: kindForEndpoints(upstreamEndpoints),
          upstreamEndpoints,
          providerData: {
            deployment: deployment.deployment,
          } satisfies AzureProviderData,
          ...(deployment.cost ? { cost: deployment.cost } : {}),
          enabledFlags: effective,
        };
      });
    },
    getPricingForModelKey(modelKey) {
      return azure.config.deployments.find(deployment => deployment.deployment === modelKey)?.cost ?? null;
    },
    callChatCompletions: (model, body, signal) => call('chat_completions', model, body, signal),
    callResponses: (model, body, signal) => call('responses', model, body, signal),
    callMessages: (model, body, signal, anthropicBeta) =>
      call('messages', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callMessagesCountTokens: (model, body, signal, anthropicBeta) =>
      call('messages_count_tokens', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callEmbeddings: (model, body, signal) => call('embeddings', model, body, signal),
    callImagesGenerations: () => {
      throw new Error('Azure provider stub: callImagesGenerations not yet implemented');
    },
    callImagesEdits: () => {
      throw new Error('Azure provider stub: callImagesEdits not yet implemented');
    },
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    provider,
  };
};
