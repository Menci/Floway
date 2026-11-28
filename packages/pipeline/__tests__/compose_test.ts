import { expect, it } from 'vitest';

import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, defineFacts, optional, required, transform } from '../src/index.ts';
import type { Entry, Pipeline } from '../src/index.ts';

it('resolves a cross-operation mutual cycle synchronously through thunk and direct targets', async () => {
  type AnthropicRq = { payload: { kind: 'anthropic'; count: number }; forward: boolean };
  type AnthropicRs = { outcome: { kind: 'anthropic'; text: string } };
  type ResponsesRq = { payload: { kind: 'responses'; count: number }; forward: boolean };
  type ResponsesRs = { outcome: { kind: 'responses'; text: string } };

  const anthropic = defineFacts<AnthropicRq, AnthropicRs>();
  const responses = defineFacts<ResponsesRq, ResponsesRs>();
  const checks: string[] = [];
  const execution: string[] = [];

  const responsesEnding = responses.defineStage({
    name: 'openaiResponses.route',
    request: { needs: { payload: required<ResponsesRq['payload']>(), forward: required<boolean>() } },
    into: {
      peer: {
        target: anthropic,
        request: {
          needs: { payload: required<ResponsesRq['payload']>(), forward: required<boolean>() },
          provides: { payload: required<AnthropicRq['payload']>(), forward: required<boolean>() },
          consumes: [],
        },
        response: {
          needs: { outcome: required<AnthropicRs['outcome']>() },
          provides: { outcome: required<ResponsesRs['outcome']>() },
          consumes: [],
        },
      },
    },
    return: { provides: { outcome: required<ResponsesRs['outcome']>() } },
    execute: async (facts, scope) => {
      execution.push('openaiResponses');
      if (facts.forward) {
        const back = await scope.into.peer({
          ...facts,
          payload: { kind: 'anthropic', count: facts.payload.count + 1 },
          forward: false,
        });
        return { ...back, outcome: { kind: 'responses', text: `translated(${back.outcome.text})` } };
      }
      return { outcome: { kind: 'responses', text: `responses:${facts.payload.count}` } };
    },
  });

  const anthropicEnding = anthropic.defineStage({
    name: 'anthropicMessages.route',
    request: { needs: { payload: required<AnthropicRq['payload']>(), forward: required<boolean>() } },
    into: {
      peer: {
        target: responses,
        request: {
          needs: { payload: required<AnthropicRq['payload']>(), forward: required<boolean>() },
          provides: { payload: required<ResponsesRq['payload']>(), forward: required<boolean>() },
          consumes: [],
        },
        response: {
          needs: { outcome: required<ResponsesRs['outcome']>() },
          provides: { outcome: required<AnthropicRs['outcome']>() },
          consumes: [],
        },
      },
    },
    return: { provides: { outcome: required<AnthropicRs['outcome']>() } },
    execute: async (facts, scope) => {
      execution.push('anthropicMessages');
      if (facts.forward) {
        const back = await scope.into.peer({
          ...facts,
          payload: { kind: 'responses', count: facts.payload.count + 1 },
          forward: false,
        });
        return { ...back, outcome: { kind: 'anthropic', text: `translated(${back.outcome.text})` } };
      }
      return { outcome: { kind: 'anthropic', text: `anthropic:${facts.payload.count}` } };
    },
  });

  const responsesPipeline: Pipeline<ResponsesRq, ResponsesRs> = responses.compose('openaiResponses', {
    entry: { payload: required<ResponsesRq['payload']>(), forward: required<boolean>() },
    exit: { outcome: required<ResponsesRs['outcome']>() },
    stages: [],
    ending: responsesEnding,
    targets: {
      peer: () => {
        checks.push('anthropicMessages');
        return anthropicPipeline;
      },
    },
  });

  const anthropicPipeline = anthropic.compose('anthropicMessages', {
    entry: { payload: required<AnthropicRq['payload']>(), forward: required<boolean>() },
    exit: { outcome: required<AnthropicRs['outcome']>() },
    stages: [],
    ending: anthropicEnding,
    targets: { peer: responsesPipeline },
  });

  expect(checks).toEqual([]);
  const entry = asEntry(responsesPipeline);
  expect(checks).toEqual(['anthropicMessages']);
  expect(execution).toEqual([]);

  const { host, services } = hostFor({});
  const call = host.run(entry, { payload: { kind: 'responses', count: 3 }, forward: true }, { services });
  const answer = await call;
  expect(answer).toEqual({ outcome: { kind: 'responses', text: 'translated(anthropic:4)' } });
  expect(execution).toEqual(['openaiResponses', 'anthropicMessages']);

  // Second entry in the already-validated cycle reuses cached validation without re-running the thunk.
  asEntry(anthropicPipeline);
  expect(checks).toEqual(['anthropicMessages']);
  host.abort(call).discard();
  host.close();
});

it('rejects phantom exit keys and non-terminating loops in cyclic validateResponse fixed point', () => {
  type Rq = { seed: number };
  type Rs = { outcome: string; phantom: number; added: string };
  const space = defineFacts<Rq, Rs>();

  const relayOnly = (name: string) => space.defineStage({
    name,
    request: { needs: { seed: required<number>() } },
    into: { peer: { request: emptySide, response: { needs: { outcome: required<string>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.peer(facts),
  });
  const relayOrReturn = (name: string) => space.defineStage({
    name,
    request: { needs: { seed: required<number>() } },
    into: { peer: { request: emptySide, response: { needs: { outcome: required<string>() }, provides: {}, consumes: [] } } },
    return: { provides: { outcome: required<string>() } },
    execute: async () => ({ outcome: 'ok' }),
  });

  // Phantom optional key claimed by both cyclic pipelines without any stage producing it.
  const lyingA: Pipeline<{ seed: number }, { outcome: string; phantom?: number }> = space.compose('lyingA', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>(), phantom: optional<number>() },
    stages: [],
    ending: relayOnly('lyingA.end'),
    targets: { peer: () => lyingB },
  });
  const lyingB = space.compose('lyingB', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>(), phantom: optional<number>() },
    stages: [],
    ending: relayOrReturn('lyingB.end'),
    targets: { peer: lyingA },
  });
  expect(() => asEntry(lyingA)).toThrow('exit disagrees with the stages on "phantom"');

  // Unproductive cycle with no terminating return path anywhere.
  const loopA: Pipeline<{ seed: number }, { outcome: string }> = space.compose('loopA', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: relayOnly('loopA.end'),
    targets: { peer: () => loopB },
  });
  const loopB = space.compose('loopB', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: relayOnly('loopB.end'),
    targets: { peer: loopA },
  });
  expect(() => asEntry(loopA)).toThrow('has no terminating response path');

  // Unproductive self-cycle B -> B with no return anywhere.
  const selfLoop: Pipeline<{ seed: number }, { outcome: string }> = space.compose('selfLoop', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: relayOnly('selfLoop.end'),
    targets: { peer: () => selfLoop },
  });
  expect(() => asEntry(selfLoop)).toThrow('has no terminating response path');

  // Valid cycle where neither ending has return, but an earlier stage in A declares through + return.
  const earlyReturn = space.defineStage({
    name: 'early-return',
    through: {
      request: { needs: { seed: required<number>() }, provides: { seed: required<number>() }, consumes: [] },
      response: { needs: { outcome: required<string>() }, provides: {}, consumes: [] },
    },
    return: { provides: { outcome: required<string>() } },
    execute: async (facts, scope) => {
      if (facts.seed <= 0) return { outcome: 'short-circuited' };
      return await scope.next({ ...facts, seed: facts.seed - 1 });
    },
  });
  const stageReturnA: Pipeline<{ seed: number }, { outcome: string }> = space.compose('stageReturnA', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>() },
    stages: [earlyReturn],
    ending: relayOnly('stageReturnA.end'),
    targets: { peer: () => stageReturnB },
  });
  const stageReturnB = space.compose('stageReturnB', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: relayOnly('stageReturnB.end'),
    targets: { peer: stageReturnA },
  });
  expect(() => asEntry(stageReturnA)).not.toThrow();

  // Valid cycle where one edge genuinely adds an optional key converges cleanly.
  const edgeAddsKey = space.defineStage({
    name: 'edge-adds-key',
    request: { needs: { seed: required<number>() } },
    into: {
      peer: {
        request: emptySide,
        response: {
          needs: { outcome: required<string>() },
          provides: { added: optional<string>() },
          consumes: [],
        },
      },
    },
    return: { provides: { outcome: required<string>() } },
    execute: async () => ({ outcome: 'base' }),
  });
  const validA: Pipeline<{ seed: number }, { outcome: string; added?: string }> = space.compose('validA', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>(), added: optional<string>() },
    stages: [],
    ending: edgeAddsKey,
    targets: { peer: () => validB },
  });
  const validB = space.compose('validB', {
    entry: { seed: required<number>() },
    exit: { outcome: required<string>(), added: optional<string>() },
    stages: [],
    ending: relayOrReturn('validB.end'),
    targets: { peer: validA },
  });
  expect(() => asEntry(validA)).not.toThrow();
});

it('validates homogeneous runtime plugin target maps synchronously at asEntry', async () => {
  type UpstreamRq = { provider: string; payload: string };
  type UpstreamRs = { outcome: string; usageModelKey: string };
  interface UpstreamSvc { readonly prefix: string }
  interface GatewaySvc extends UpstreamSvc { readonly tag: string }

  const upstreamBase = defineFacts<UpstreamRq, UpstreamRs, UpstreamSvc>();
  const gatewaySpace = upstreamBase.extend<{ traceId: string }, object, GatewaySvc>();

  const dispatch = gatewaySpace.defineStage({
    name: 'provider.dispatch',
    request: { needs: { provider: required<string>(), payload: required<string>() } },
    into: {
      target: upstreamBase,
      request: emptySide,
      response: {
        needs: { outcome: required<string>(), usageModelKey: optional<string>() },
        provides: {},
        consumes: [],
      },
    },
    execute: async (facts, scope) => {
      expect(Object.getPrototypeOf(scope.into)).toBeNull();
      expect(scope.into.toString).toBeUndefined();
      const target = scope.into[facts.provider];
      if (!target) throw new Error(`Unknown provider "${facts.provider}"`);
      return await target(facts);
    },
  });

  type UpstreamPlugin = Pipeline<
    { readonly provider: string; readonly payload: string },
    { readonly outcome: string; readonly usageModelKey?: string },
    UpstreamSvc
  >;

  const alphaSpace = upstreamBase.extend<{ 'alpha.secret': string }, object>();
  const alphaPlugin: UpstreamPlugin = alphaSpace.compose('plugin.alpha', {
    entry: { payload: required<string>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: alphaSpace.defineStage({
      name: 'alpha.end',
      request: { needs: { payload: required<string>() } },
      return: { provides: { outcome: required<string>() } },
      execute: async ({ payload }, scope) => ({ outcome: `${scope.services.prefix}:alpha:${payload}` }),
    }),
  });

  const betaPlugin: UpstreamPlugin = upstreamBase.compose('plugin.beta', {
    entry: { provider: required<string>(), payload: required<string>() },
    exit: { outcome: required<string>(), usageModelKey: required<string>() },
    stages: [],
    ending: upstreamBase.defineStage({
      name: 'beta.end',
      request: { needs: { provider: required<string>(), payload: required<string>() } },
      return: { provides: { outcome: required<string>(), usageModelKey: required<string>() } },
      execute: async ({ provider, payload }) => ({ outcome: `${provider}:${payload}`, usageModelKey: 'beta-v1' }),
    }),
  });

  const runtimePlugins: Readonly<Record<string, UpstreamPlugin>> = {
    alpha: alphaPlugin,
    beta: betaPlugin,
  };

  const entry = asEntry(gatewaySpace.compose('gateway.egress', {
    entry: { provider: required<string>(), payload: required<string>() },
    exit: { outcome: required<string>(), usageModelKey: optional<string>() },
    stages: [],
    ending: dispatch,
    targets: runtimePlugins,
  }));

  const { host, services } = hostFor<GatewaySvc>({ prefix: 'live', tag: 'gw' });
  const call1 = host.run(entry, { provider: 'alpha', payload: 'hello' }, { services });
  expect(await call1).toEqual({ outcome: 'live:alpha:hello' });
  host.abort(call1).discard();

  const call2 = host.run(entry, { provider: 'beta', payload: 'world' }, { services });
  expect(await call2).toEqual({ outcome: 'beta:world', usageModelKey: 'beta-v1' });
  host.abort(call2).discard();
  host.close();

  // Runtime-incompatible dynamically loaded plugin is rejected synchronously at asEntry.
  const brokenPlugin = alphaSpace.compose('plugin.broken', {
    entry: { payload: required<string>(), 'alpha.secret': optional<string>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: alphaSpace.defineStage({
      name: 'broken.end',
      request: { needs: { payload: required<string>(), 'alpha.secret': optional<string>() } },
      return: { provides: { outcome: required<string>() } },
      execute: async ({ payload }) => ({ outcome: payload }),
    }),
  });

  const badAssembly = gatewaySpace.compose('gateway.bad-plugins', {
    entry: { provider: required<string>(), payload: required<string>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: dispatch,
    targets: { broken: brokenPlugin as unknown as UpstreamPlugin },
  });
  expect(() => asEntry(badAssembly)).toThrow('gateway.bad-plugins into "broken" request does not provide or declare optional target key "alpha.secret"');

  const missingOutcomePlugin = upstreamBase.compose('plugin.missing-outcome', {
    entry: { payload: required<string>() },
    exit: { outcome: optional<string>() },
    stages: [],
    ending: upstreamBase.defineStage({
      name: 'missing-outcome.end',
      request: { needs: { payload: required<string>() } },
      return: { provides: { outcome: optional<string>() } },
      execute: async () => ({}),
    }),
  });
  const badExitMissingAssembly = gatewaySpace.compose('gateway.bad-exit-missing', {
    entry: { provider: required<string>(), payload: required<string>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: dispatch,
    targets: { missing: missingOutcomePlugin as unknown as UpstreamPlugin },
  });
  expect(() => asEntry(badExitMissingAssembly)).toThrow('gateway.bad-exit-missing into "missing" response does not guarantee "outcome"');

  const extraExitSpace = upstreamBase.extend<object, { 'extra.leak': number }>();
  const extraExitPlugin = extraExitSpace.compose('plugin.extra-exit', {
    entry: { payload: required<string>() },
    exit: { outcome: required<string>(), 'extra.leak': required<number>() },
    stages: [],
    ending: extraExitSpace.defineStage({
      name: 'extra-exit.end',
      request: { needs: { payload: required<string>() } },
      return: { provides: { outcome: required<string>(), 'extra.leak': required<number>() } },
      execute: async ({ payload }) => ({ outcome: payload, 'extra.leak': 1 }),
    }),
  });
  const badExitExtraAssembly = gatewaySpace.compose('gateway.bad-exit-extra', {
    entry: { provider: required<string>(), payload: required<string>() },
    exit: { outcome: required<string>() },
    stages: [],
    ending: dispatch,
    targets: { leaky: extraExitPlugin as unknown as UpstreamPlugin },
  });
  expect(() => asEntry(badExitExtraAssembly)).toThrow('gateway.bad-exit-extra exit disagrees with the stages on "extra.leak"');
});

it('rejects blind optional passthrough while accepting declared, provided, and consumed optional target keys', async () => {
  type Rq = { seed: number; opt: string };
  type Rs = { delivered: string };
  const space = defineFacts<Rq, Rs>();

  const target = space.compose('target', {
    entry: { seed: required<number>(), opt: optional<string>() },
    exit: { delivered: required<string>() },
    stages: [],
    ending: space.defineStage({
      name: 'target.end',
      request: { needs: { seed: required<number>(), opt: optional<string>() } },
      return: { provides: { delivered: required<string>() } },
      execute: async ({ seed, opt }) => ({ delivered: `${seed}:${opt ?? 'absent'}` }),
    }),
  });

  const blindRelay = space.defineStage({
    name: 'blind-relay',
    request: { needs: { seed: required<number>() } },
    into: { target: { request: emptySide, response: { needs: { delivered: required<string>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });

  // Blind passthrough without declaring or providing `opt` fails at asEntry.
  const blind = space.compose('blind', {
    entry: { seed: required<number>() },
    exit: { delivered: required<string>() },
    stages: [],
    ending: blindRelay,
    targets: { target: target as unknown as Pipeline<{ readonly seed: number }, { readonly delivered: string }> },
  });
  expect(() => asEntry(blind)).toThrow('blind into "target" request does not provide or declare optional target key "opt"');

  // Explicitly providing `opt` optionally satisfies the target boundary without adding `opt` to outer entry.
  const optProvider = space.defineStage({
    name: 'opt-provider',
    through: {
      request: { needs: { seed: required<number>() }, provides: { opt: optional<string>() }, consumes: [] },
      response: { needs: { delivered: required<string>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => await scope.next(facts.seed > 0 ? { ...facts, opt: 'supplied' } : facts),
  });
  const providedEntry = asEntry(space.compose('provided-opt', {
    entry: { seed: required<number>() },
    exit: { delivered: required<string>() },
    stages: [optProvider],
    ending: blindRelay,
    targets: { target },
  }));

  // Explicitly declaring `opt` in caller entry also satisfies the target boundary.
  const declaredRelay = space.defineStage({
    name: 'declared-relay',
    request: { needs: { seed: required<number>() } },
    into: {
      target: {
        request: { needs: { opt: optional<string>() }, provides: {}, consumes: [] },
        response: { needs: { delivered: required<string>() }, provides: {}, consumes: [] },
      },
    },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const declaredEntry = asEntry(space.compose('declared-opt', {
    entry: { seed: required<number>(), opt: optional<string>() },
    exit: { delivered: required<string>() },
    stages: [],
    ending: declaredRelay,
    targets: { target },
  }));

  // Explicitly consuming a differently-typed `opt` makes it provably absent at the target boundary.
  const otherSpace = defineFacts<{ seed: number; opt: number }, Rs>();
  const consumeOpt = otherSpace.defineStage({
    name: 'consume-opt',
    through: {
      request: { needs: { seed: required<number>(), opt: optional<number>() }, provides: {}, consumes: ['opt'] },
      response: { needs: { delivered: required<string>() }, provides: {}, consumes: [] },
    },
    execute: async ({ opt: _, ...rest }, scope) => await scope.next(rest),
  });
  const otherRelay = otherSpace.defineStage({
    name: 'other-relay',
    request: { needs: { seed: required<number>() } },
    into: { target: { request: emptySide, response: { needs: { delivered: required<string>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const consumedEntry = asEntry(otherSpace.compose('consumed-opt', {
    entry: { seed: required<number>(), opt: optional<number>() },
    exit: { delivered: required<string>() },
    stages: [consumeOpt],
    ending: otherRelay,
    targets: { target },
  }));

  const { host, services } = hostFor({});
  const c1 = host.run(providedEntry, { seed: 1 }, { services });
  expect(await c1).toEqual({ delivered: '1:supplied' });
  host.abort(c1).discard();

  const c2 = host.run(providedEntry, { seed: 0 }, { services });
  expect(await c2).toEqual({ delivered: '0:absent' });
  host.abort(c2).discard();

  const c3 = host.run(declaredEntry, { seed: 2 }, { services });
  expect(await c3).toEqual({ delivered: '2:absent' });
  host.abort(c3).discard();

  const c4 = host.run(consumedEntry, { seed: 3, opt: 99 }, { services });
  expect(await c4).toEqual({ delivered: '3:absent' });
  host.abort(c4).discard();
  host.close();
});

it('rejects unchecked entries, entry/exit disagreements, use-after-consume, and uncovered in-place returns', () => {
  type Rq = { request: number; alternative: number };
  type Rs = { response: number; alternative: number };
  const space = defineFacts<Rq, Rs>();

  const terminal = space.defineStage({
    name: 'terminal',
    request: { needs: { request: required<number>() } },
    return: { provides: { response: required<number>() } },
    execute: async facts => ({ response: facts.request }),
  });

  expect(() => space.compose('bad-entry', {
    entry: { alternative: required<number>() },
    exit: { response: required<number>() },
    stages: [],
    ending: terminal,
  })).toThrow('bad-entry entry disagrees with the stages');

  expect(() => space.compose('bad-exit', {
    entry: { request: required<number>() },
    exit: { alternative: required<number>() },
    stages: [],
    ending: terminal,
  })).toThrow('bad-exit exit disagrees with the stages');

  const consume = space.defineStage({
    name: 'consume',
    through: {
      request: { needs: { request: required<number>() }, provides: {}, consumes: ['request'] },
      response: emptySide,
    },
    execute: async ({ request: _, ...rest }, scope) => await scope.next(rest),
  });
  expect(() => space.compose('after-consume', {
    entry: { request: required<number>() },
    exit: { response: required<number>() },
    stages: [consume],
    ending: terminal,
  })).toThrow('terminal requires "request" after it was consumed');

  const shortCircuit = space.defineStage({
    name: 'short',
    through: { request: emptySide, response: emptySide },
    return: { provides: { alternative: required<number>() } },
    execute: async () => ({ alternative: 1 }),
  });
  const requiresResponse = space.defineStage({
    name: 'requires-response',
    through: {
      request: emptySide,
      response: { needs: { response: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => await scope.next(facts),
  });
  expect(() => space.compose('uncovered', {
    entry: { request: required<number>() },
    exit: { response: required<number>() },
    stages: [requiresResponse, shortCircuit],
    ending: terminal,
  })).toThrow('requires-response child response does not guarantee "response"');

  const unchecked = space.compose('valid-unchecked', {
    entry: { request: required<number>() },
    exit: { response: required<number>() },
    stages: [],
    ending: terminal,
  });
  const { host, services } = hostFor({});
  expect(() => host.run(unchecked as Entry<{ request: number }, { response: number }>, { request: 1 }, { services }))
    .toThrow('Expected a checked entry for pipeline "valid-unchecked"');
  host.close();

  expect(() => space.defineStage({
    name: 'forged-slot',
    request: { needs: { request: {} as never } },
    return: { provides: { response: required<number>() } },
    execute: async () => ({ response: 1 }),
  })).toThrow('must use required<T>() or optional<T>()');

  expect(() => space.defineStage({
    name: 'missing-request',
    return: { provides: { response: required<number>() } },
    execute: async () => ({ response: 1 }),
  } as never)).toThrow('Stage "missing-request" requires a request declaration');

  expect(() => space.compose('null-ending', {
    entry: {},
    exit: {},
    stages: [],
    ending: null as never,
  })).toThrow('Expected a defined stage');
  expect(() => asEntry(null as never)).toThrow('Expected a composed pipeline');
  const { host: invalidHost, services: invalidServices } = hostFor({});
  expect(() => invalidHost.run(null as never, {}, { services: invalidServices })).toThrow('Expected a checked entry for pipeline');
  invalidHost.close();
});

it('keeps directional namespaces separate when the same key has different request and response types', async () => {
  type Rq = { http: { url: string } };
  type Rs = { http: { status: number } };
  const space = defineFacts<Rq, Rs>();
  const sent: string[] = [];
  const observed: [string, number][] = [];

  const caller = space.defineStage({
    name: 'caller',
    through: {
      request: { needs: { http: required<{ url: string }>() }, provides: {}, consumes: [] },
      response: { needs: { http: required<{ status: number }>() }, provides: {}, consumes: [] },
    },
    execute: transform(() => {
      let originalUrl = '';
      return {
        request: facts => {
          originalUrl = facts.http.url;
          return facts;
        },
        response: back => {
          observed.push([originalUrl, back.http.status]);
          return back;
        },
      };
    }),
  });

  const rewrite = space.defineStage({
    name: 'rewrite',
    through: {
      request: { needs: { http: required<{ url: string }>() }, provides: { http: required<{ url: string }>() }, consumes: [] },
      response: { needs: { http: required<{ status: number }>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => await scope.next({ ...facts, http: { url: `${facts.http.url}/rewritten` } }),
  });

  const terminal = space.defineStage({
    name: 'terminal',
    request: { needs: { http: required<{ url: string }>() } },
    return: { provides: { http: required<{ status: number }>() } },
    execute: async ({ http }) => {
      sent.push(http.url);
      return { http: { status: 201 } };
    },
  });

  const entry = asEntry(space.compose('directional', {
    entry: { http: required<{ url: string }>() },
    exit: { http: required<{ status: number }>() },
    stages: [caller, rewrite],
    ending: terminal,
  }));

  const { host, services } = hostFor({});
  const call = host.run(entry, { http: { url: 'https://example.test' } }, { services });
  expect(await call).toEqual({ http: { status: 201 } });
  expect(sent).toEqual(['https://example.test/rewritten']);
  expect(observed).toEqual([['https://example.test', 201]]);
  host.abort(call).discard();
  host.close();
});

it('reuses a parent-space stage in an extended space and preserves extra facts across handoff', async () => {
  const base = defineFacts<{ same: string }, { same: number }>();
  const extended = base.extend<{ other: number }, { extra: string }>();

  const reusable = base.defineStage({
    name: 'reusable',
    through: {
      request: { needs: { same: required<string>() }, provides: {}, consumes: [] },
      response: { needs: { same: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => await scope.next(facts),
  });

  const terminal = extended.defineStage({
    name: 'terminal',
    request: { needs: { same: required<string>(), other: required<number>() } },
    return: { provides: { same: required<number>(), extra: required<string>() } },
    execute: async facts => ({ same: facts.other, extra: facts.same }),
  });

  const entry = asEntry(extended.compose('extended', {
    entry: { same: required<string>(), other: required<number>() },
    exit: { same: required<number>(), extra: required<string>() },
    stages: [reusable],
    ending: terminal,
  }));

  const { host, services } = hostFor({});
  const call = host.run(entry, { same: 'hello', other: 7 }, { services });
  expect(await call).toEqual({ same: 7, extra: 'hello' });
  host.abort(call).discard();
  host.close();
});

it('rejects a leaked non-enumerable own key from a nested pipeline exit', async () => {
  const inner = defineFacts<object, { value: number }>();
  const outer = defineFacts<object, { value: string }>();

  const badInner = inner.compose('nested', {
    entry: {},
    exit: {},
    stages: [],
    ending: inner.defineStage({
      name: 'leak-key',
      request: { needs: {} },
      return: { provides: {} },
      execute: async () => Object.defineProperty({}, 'value', { value: 42, enumerable: false }),
    }),
  });

  const relay = outer.defineStage({
    name: 'relay',
    request: { needs: {} },
    into: { nested: { request: emptySide, response: { needs: { value: optional<string>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.nested(facts),
  });

  const entry = asEntry(outer.compose('outer', {
    entry: {},
    exit: {},
    stages: [],
    ending: relay,
    targets: { nested: badInner },
  }));

  const { host, services } = hostFor({});
  await expect(host.run(entry, {}, { services })).rejects.toThrow('Stage "leak-key" response returned undeclared "value"');
  host.close();
});
