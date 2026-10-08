import { expect, test, vi } from 'vitest';

import { renderAgentExtension } from '../src/render-extension.ts';

const evaluateExtension = async (source: string, api: Record<string, unknown>) => {
  const executable = source.replace(/^import .*;\n/gm, '').replace('export default async pi =>', 'return async pi =>');
  const create = new Function('USER_AGENT', 'streamSimple', 'buildModel', executable);
  const extension = create('omp/18.8.4', api.streamSimple, api.buildModel);
  await extension(api);
};

test('the short extension safely embeds connection credentials and forwards native declarations', async () => {
  const key = "key'\n\\quote";
  const source = renderAgentExtension({ agent: 'omp', provider: 'floway', endpoint: 'https://gateway.example/gateway', apiKey: key });
  const configuration = { api: 'floway:floway', models: [{ id: 'alias', thinking: { mode: 'effort', efforts: ['low', 'high'] } }], wireApis: { alias: 'anthropic-messages' }, streamOptions: { alias: { thinkingBudgets: { low: 1100 } } }, payloadRemovals: { alias: [['output_config', 'effort']] } };
  const fetch = vi.fn().mockResolvedValue(Response.json(configuration));
  vi.stubGlobal('fetch', fetch);
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const registerCommand = vi.fn();
  const buildModel = vi.fn(model => model);
  const streamSimple = vi.fn();
  try {
    await evaluateExtension(source, { registerProvider, unregisterProvider, registerCommand, buildModel, streamSimple });
    expect(fetch).toHaveBeenCalledWith('https://gateway.example/gateway/v1/models?endpoint=https%3A%2F%2Fgateway.example%2Fgateway&provider=floway', expect.objectContaining({ headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'omp/18.8.4' } }));
    expect(unregisterProvider).not.toHaveBeenCalled();
    const registered = registerProvider.mock.calls[0][1];
    expect(registered.models).toEqual(configuration.models);
    const model = { id: 'alias', api: 'floway:floway', compatConfig: { supportsReasoningEffort: true }, thinking: configuration.models[0].thinking };
    const onPayload = vi.fn(payload => ({ ...payload, fromHook: true }));
    registered.streamSimple(model, { messages: [] }, { reasoning: 'low', maxInFlightRequests: { floway: 1 }, onPayload });
    expect(buildModel).toHaveBeenCalledWith({ ...model, api: 'anthropic-messages', compat: model.compatConfig });
    expect(streamSimple).toHaveBeenCalledWith(expect.objectContaining({ api: 'anthropic-messages' }), { messages: [] }, expect.objectContaining({ reasoning: 'low', thinkingBudgets: { low: 1100 }, maxInFlightRequests: {} }));
    const payload = { output_config: { effort: 'high', format: { type: 'json_schema' } }, thinking: { type: 'adaptive' } };
    const transformed = await streamSimple.mock.calls[0][2].onPayload(payload, model);
    expect(payload).toEqual({ output_config: { format: { type: 'json_schema' } }, thinking: { type: 'adaptive' } });
    expect(onPayload).toHaveBeenCalledWith(payload, model);
    expect(transformed.fromHook).toBe(true);
    fetch.mockResolvedValueOnce(Response.json({ ...configuration, models: [] }));
    await registerCommand.mock.calls[0][1].handler();
    expect(unregisterProvider).toHaveBeenCalledWith('floway');
    expect(registerProvider.mock.calls[1][1].models).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each([new Response(null, { status: 503 }), Response.json({ data: [] })])('a failed refresh keeps the last successful registry', async response => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ api: 'floway:floway', models: [{ id: 'alias' }], wireApis: {}, streamOptions: {} })).mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetch);
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const registerCommand = vi.fn();
  try {
    await evaluateExtension(renderAgentExtension({ agent: 'omp', provider: 'floway', endpoint: 'https://gateway.example', apiKey: 'key' }), { registerProvider, unregisterProvider, registerCommand });
    await expect(registerCommand.mock.calls[0][1].handler()).rejects.toThrow();
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(unregisterProvider).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('one extension preserves independent provider catalogs, credentials and stream bridges', async () => {
  const connections = [
    { provider: 'work', endpoint: 'https://work.example/gateway', apiKey: 'work-key' },
    { provider: 'personal', endpoint: 'https://personal.example', apiKey: 'personal-key' },
  ];
  const source = renderAgentExtension({ agent: 'omp', ...connections[0] }).replace(/^const connections = .*;$/m, `const connections = ${JSON.stringify(connections)};`);
  const configurations = connections.map(({ provider }, index) => ({
    api: `floway:${provider}`,
    models: [{ id: 'shared-alias', api: `floway:${provider}` }],
    wireApis: { 'shared-alias': index === 0 ? 'anthropic-messages' : 'openai-responses' },
    streamOptions: { 'shared-alias': { thinkingBudgets: { high: 1100 + index } } },
    payloadRemovals: { 'shared-alias': index === 0 ? [['output_config', 'effort']] : [] },
  }));
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json(configurations[0]))
    .mockResolvedValueOnce(Response.json(configurations[1]))
    .mockResolvedValueOnce(Response.json({ ...configurations[0], models: [] }))
    .mockResolvedValueOnce(Response.json(configurations[1]));
  vi.stubGlobal('fetch', fetch);
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const registerCommand = vi.fn();
  const buildModel = vi.fn(model => model);
  const streamSimple = vi.fn();
  try {
    await evaluateExtension(source, { registerProvider, unregisterProvider, registerCommand, buildModel, streamSimple });
    expect(registerProvider.mock.calls.map(([provider, configuration]) => [provider, configuration.api, configuration.apiKey])).toEqual([
      ['work', 'floway:work', 'work-key'],
      ['personal', 'floway:personal', 'personal-key'],
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://work.example/gateway/v1/models?endpoint=https%3A%2F%2Fwork.example%2Fgateway&provider=work',
      'https://personal.example/v1/models?endpoint=https%3A%2F%2Fpersonal.example&provider=personal',
    ]);
    for (const [, configuration] of registerProvider.mock.calls) {
      configuration.streamSimple({ id: 'shared-alias', compatConfig: {} }, { messages: [] }, { reasoning: 'high' });
    }
    expect(streamSimple.mock.calls.map(([model, , options]) => [model.api, options.thinkingBudgets.high])).toEqual([
      ['anthropic-messages', 1100],
      ['openai-responses', 1101],
    ]);
    const workPayload = { output_config: { effort: 'high', format: 'json' } };
    const personalPayload = { output_config: { effort: 'high', format: 'json' } };
    await streamSimple.mock.calls[0][2].onPayload(workPayload);
    await streamSimple.mock.calls[1][2].onPayload(personalPayload);
    expect(workPayload).toEqual({ output_config: { format: 'json' } });
    expect(personalPayload).toEqual({ output_config: { effort: 'high', format: 'json' } });
    expect(registerCommand).toHaveBeenCalledTimes(1);
    await registerCommand.mock.calls[0][1].handler();
    expect(unregisterProvider.mock.calls).toEqual([['work']]);
    expect(registerProvider.mock.calls[3][0]).toBe('personal');
  } finally {
    vi.unstubAllGlobals();
  }
});
