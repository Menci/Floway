import { anthropicMessagesApi, openAIResponsesApi } from '@earendil-works/pi-ai';
import { VERSION } from '@earendil-works/pi-coding-agent';

// Use Pi's native discovery User-Agent so Floway selects the Pi catalog.
// https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/coding-agent/src/utils/pi-user-agent.ts#L1-L4
const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
const userAgent = `pi/${VERSION} (${process.platform}; ${runtime}; ${process.arch})`;

export default async pi => {
  const apis = { 'openai-responses': openAIResponsesApi(), 'anthropic-messages': anthropicMessagesApi() };
  for (const connection of connections) {
    const fetchModels = async (signal = AbortSignal.timeout(15000)) => {
      const response = await fetch(`${connection.endpoint}/v1/models?endpoint=${encodeURIComponent(connection.endpoint)}&provider=${encodeURIComponent(connection.provider)}`, {
        headers: { Authorization: `Bearer ${connection.apiKey}`, 'User-Agent': userAgent },
        signal,
      });
      if (!response.ok) throw new Error(`Floway model discovery failed: HTTP ${response.status}: ${await response.text()}`);
      const { models } = await response.json();
      if (!Array.isArray(models)) throw new Error('Floway returned an invalid model catalog');
      return models;
    };
    let models = await fetchModels();
    pi.registerProvider({
      id: connection.provider,
      name: connection.provider,
      auth: { apiKey: { name: 'Floway API key', check: async () => ({ type: 'api_key', source: 'configured API key' }), resolve: async () => ({ auth: { apiKey: connection.apiKey }, source: 'configured API key' }) } },
      getModels: () => models,
      refreshModels: async context => {
        if (!context.allowNetwork) return;
        const refreshed = await fetchModels(context.signal);
        await context.publish({
          persist: { models: refreshed, checkedAt: Date.now() },
          update: () => { models = refreshed; },
        });
      },
      stream: (model, context, options) => apis[model.api].stream(model, context, options),
      streamSimple: (model, context, options) => apis[model.api].streamSimple(model, context, {
        ...options,
        thinkingBudgets: options.thinkingBudgets ?? model.thinkingBudgets,
        onPayload: async payload => {
          const effort = model.effortOverrides?.[options.reasoning];
          if (effort !== undefined) payload.output_config = { ...payload.output_config, effort };
          for (const path of model.payloadRemovals ?? []) {
            const parent = path.slice(0, -1).reduce((value, key) => value[key], payload);
            if (parent) delete parent[path.at(-1)];
          }
          return options.onPayload?.(payload, model);
        },
      }),
    });
  }
};
