import jsesc from 'jsesc';

import { normalizeAgentSetupEndpoint } from './extension-endpoint.ts';

export const renderOmpExtension = (input: { provider: string; endpoint: string; apiKey: string }): string => {
  const connections = jsesc([{ provider: input.provider, endpoint: normalizeAgentSetupEndpoint(input.endpoint), apiKey: input.apiKey }], { json: true, isScriptContext: true });
  return `// Managed by Floway Agent Setup.
const connections = ${connections};
import { USER_AGENT } from '@oh-my-pi/pi-utils';
import { streamSimple } from '@oh-my-pi/pi-ai';
import { buildModel } from '@oh-my-pi/pi-catalog/build';

export default async pi => {
  const refresh = async () => {
    for (const { provider, endpoint, apiKey } of connections) {
      const baseUrl = endpoint + '/v1';
      const response = await fetch(baseUrl + '/models?endpoint=' + encodeURIComponent(endpoint) + '&provider=' + encodeURIComponent(provider), {
        headers: { Authorization: 'Bearer ' + apiKey, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Floway model discovery failed (HTTP ' + response.status + '): ' + await response.text());
      const { wireApis, streamOptions, payloadRemovals, ...configuration } = await response.json();
      if (!Array.isArray(configuration.models)) throw new Error('Floway returned an invalid model catalog.');
      if (configuration.models.length === 0) pi.unregisterProvider(provider);
      pi.registerProvider(provider, {
        ...configuration, baseUrl, apiKey,
        streamSimple: (model, context, options) => streamSimple(
          buildModel({ ...model, api: wireApis[model.id], compat: model.compatConfig }),
          context,
          // The outer dispatcher already owns this provider's concurrency permit.
          // https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/ai/src/stream.ts
          {
            ...options, ...streamOptions[model.id], maxInFlightRequests: {},
            onPayload: async (payload, ...args) => {
              for (const path of payloadRemovals[model.id]) {
                const owner = path.slice(0, -1).reduce((value, key) => value?.[key], payload);
                if (owner) delete owner[path[path.length - 1]];
              }
              return options?.onPayload?.(payload, ...args);
            },
          },
        ),
      });
    }
  };
  await refresh();
  pi.registerCommand('floway-refresh', { description: 'Refresh Floway models', handler: refresh });
};
`;
};
