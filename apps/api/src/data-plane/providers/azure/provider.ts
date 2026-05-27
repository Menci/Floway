import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertAzureUpstreamRecord, createAzureUpstream, type AzureDeploymentConfig } from '../../../shared/upstream/azure.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { isStreamingEndpoint, kindForEndpoints, publicPathsToModelEndpoints } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import type { ModelEndpoint } from '@floway-dev/protocols/common';

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

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult> => {
    const deployment = providerData(model).deployment;
    const requestBody = isStreamingEndpoint(endpoint) ? { ...body, stream: true, model: deployment } : { ...body, model: deployment };
    return upstream
      .fetch(endpoint, { method: 'POST', body: JSON.stringify(requestBody), signal }, { extraHeaders: headers })
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
    callChatCompletions: (model, body, signal, headers) => call('chat_completions', model, body, signal, headers),
    callResponses: (model, body, signal, headers) => call('responses', model, body, signal, headers),
    callMessages: (model, body, signal, headers) => call('messages', model, body, signal, headers),
    callMessagesCountTokens: (model, body, signal, headers) => call('messages_count_tokens', model, body, signal, headers),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => call('images_generations', model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Azure routes by deployment name in the multipart `model` field; the
      // runtime re-encodes the FormData with a fresh boundary and sets
      // Content-Type itself.
      const deployment = providerData(model).deployment;
      body.append('model', deployment);
      const response = await upstream.fetch('images_edits', { method: 'POST', body, signal }, { extraHeaders: headers });
      return { response, modelKey: deployment };
    },
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    provider,
  };
};
