import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, createHostScope, defineFacts, optional, required, transform } from '../src/index.ts';
import type {
  HostScope,
  ManagedStream,
  Pipeline,
  ProducerScope,
  RootHostScope,
  StageScope,
  WorkerScope,
} from '../src/index.ts';

export const verifyMandatoryExactSlots = (): void => {
  type Rq = { count: number; label: string; tag: string | number };
  type Rs = { ok: boolean; note: string };
  const space = defineFacts<Rq, Rs>();

  space.defineStage({
    name: 'missing-type-arg-through',
    through: {
      request: {
        needs: {
          // @ts-expect-error Explicit <T> is mandatory on required<T>().
          count: required(),
          // @ts-expect-error Explicit <T> is mandatory on optional<T>().
          label: optional(),
        },
        provides: {},
        consumes: [],
      },
      response: {
        needs: {},
        provides: {
          // @ts-expect-error Explicit <T> is mandatory on response provides.
          ok: required(),
        },
        consumes: [],
      },
    },
    execute: async (facts, scope) => ({ ...(await scope.next(facts)), ok: true }),
  });

  space.defineStage({
    name: 'non-exact-types-through',
    through: {
      request: {
        needs: {
          // @ts-expect-error Narrower subtype fails ExactEqual.
          label: required<'literal'>(),
          // @ts-expect-error Wider supertype fails ExactEqual.
          count: required<number | string>(),
          // @ts-expect-error Narrower union arm fails ExactEqual.
          tag: required<string>(),
        },
        provides: {},
        consumes: [],
      },
      response: {
        needs: {},
        provides: {
          // @ts-expect-error any fails ExactEqual.
          ok: required<any>(),
          // @ts-expect-error never fails ExactEqual.
          note: optional<never>(),
        },
        consumes: [],
      },
    },
    execute: async (facts, scope) => ({ ...(await scope.next(facts)), ok: true }),
  });

  space.defineStage({
    name: 'missing-type-arg-return',
    // @ts-expect-error Return-only stage rejects omitted <T> on required() and optional().
    request: { needs: { count: required(), label: optional() } },
    return: {
      provides: {
        // @ts-expect-error Return-only stage rejects omitted <T> in return.provides.
        ok: required(),
      },
    },
    execute: async () => ({ ok: true }),
  });

  space.defineStage({
    name: 'unknown-and-overlapping-keys',
    through: {
      request: {
        needs: {
          count: required<number>(),
          // @ts-expect-error Undeclared request key.
          missing: required<string>(),
        },
        provides: {
          label: required<string>(),
        },
        // @ts-expect-error Consuming a key that is also provided is invalid.
        consumes: ['label'],
      },
      response: emptySide,
    },
    execute: async () => ({}),
  });

  space.defineStage({
    name: 'forbid-returning-consumed-key',
    through: {
      request: { needs: { label: required<string>() }, provides: {}, consumes: ['label'] },
      response: emptySide,
    },
    execute: async (facts, scope) => {
      // @ts-expect-error Consumed request key cannot be forwarded to next.
      return await scope.next(facts);
    },
  });

  const terminal = space.defineStage({
    name: 'valid-terminal',
    request: { needs: { count: required<number>() } },
    return: { provides: { ok: required<boolean>() } },
    execute: async () => ({ ok: true }),
  });

  space.compose('bad-compose-slots', {
    entry: {
      // @ts-expect-error Explicit <T> is mandatory on compose entry.
      count: required(),
    },
    exit: {
      // @ts-expect-error Type must match Rs['ok'] exactly.
      ok: required<unknown>(),
    },
    stages: [],
    ending: terminal,
  });
};

export const verifyExtendAndStageCompatibility = (): void => {
  interface BaseServices { readonly base: () => string }
  interface ChildServices extends BaseServices { readonly extra: () => number }
  interface SiblingServices extends BaseServices { readonly sibling: () => boolean }

  type BaseRq = { shared: string };
  type BaseRs = { result: number };

  const base = defineFacts<BaseRq, BaseRs, BaseServices>();
  const child = base.extend<{ childOnly: boolean }, { childOut: string }, ChildServices>();
  const sibling = base.extend<{ siblingOnly: number }, { siblingOut: boolean }, SiblingServices>();

  const parentStage = base.defineStage({
    name: 'parent-stage',
    through: {
      request: { needs: { shared: required<string>() }, provides: {}, consumes: [] },
      response: { needs: { result: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => {
      scope.services.base();
      return await scope.next(facts);
    },
  });

  const siblingStage = sibling.defineStage({
    name: 'sibling-stage',
    through: {
      request: { needs: { siblingOnly: required<number>() }, provides: {}, consumes: [] },
      response: emptySide,
    },
    execute: async (facts, scope) => await scope.next(facts),
  });

  const childTerminal = child.defineStage({
    name: 'child-terminal',
    request: { needs: { shared: required<string>(), childOnly: required<boolean>() } },
    return: { provides: { result: required<number>(), childOut: required<string>() } },
    execute: async (facts, scope) => ({
      result: scope.services.extra(),
      childOut: `${facts.shared}:${facts.childOnly}`,
    }),
  });

  // Parent-space stage is reusable in extended child space.
  child.compose('valid-extended', {
    entry: { shared: required<string>(), childOnly: required<boolean>() },
    exit: { result: required<number>(), childOut: required<string>() },
    stages: [parentStage],
    ending: childTerminal,
  });

  // Sibling-space stage is rejected in child space.
  child.compose('reject-sibling', {
    entry: { shared: required<string>(), childOnly: required<boolean>() },
    exit: { result: required<number>(), childOut: required<string>() },
    // @ts-expect-error Sibling stage uses keys and services outside child space.
    stages: [siblingStage],
    ending: childTerminal,
  });

  // Foreign stages touching keys outside the space ONLY via consumes are rejected.
  const foreign = base.extend<{ foreignRq: number }, { foreignRs: number }>();
  const consumesForeignRq = foreign.defineStage({
    name: 'consumes-foreign-rq',
    through: {
      request: { needs: {}, provides: {}, consumes: ['foreignRq'] },
      response: emptySide,
    },
    execute: async (facts, scope) => await scope.next(facts),
  });
  const consumesForeignRs = foreign.defineStage({
    name: 'consumes-foreign-rs',
    through: {
      request: emptySide,
      response: { needs: {}, provides: {}, consumes: ['foreignRs'] },
    },
    execute: async (facts, scope) => await scope.next(facts),
  });
  const namedIntoConsumesForeignRq = foreign.defineStage({
    name: 'named-into-consumes-foreign-rq',
    request: { needs: {} },
    into: {
      peer: {
        request: { needs: {}, provides: {}, consumes: ['foreignRq'] },
        response: emptySide,
      },
    },
    execute: async (facts, scope) => await scope.into.peer(facts),
  });
  const homogeneousIntoConsumesForeignRq = foreign.defineStage({
    name: 'homogeneous-into-consumes-foreign-rq',
    request: { needs: {} },
    into: {
      request: { needs: {}, provides: {}, consumes: ['foreignRq'] },
      response: emptySide,
    },
    execute: async (facts, scope) => await scope.into.peer!(facts),
  });
  const baseLeaf = base.compose('base-leaf', {
    entry: {},
    exit: {},
    stages: [],
    ending: base.defineStage({
      name: 'base-leaf-end',
      request: { needs: {} },
      return: { provides: {} },
      execute: async () => ({}),
    }),
  });

  child.compose('reject-foreign-request-consumes', {
    entry: { shared: required<string>(), childOnly: required<boolean>() },
    exit: { result: required<number>(), childOut: required<string>() },
    // @ts-expect-error Stage consumes request key foreignRq outside child space.
    stages: [consumesForeignRq],
    ending: childTerminal,
  });
  child.compose('reject-foreign-response-consumes', {
    entry: { shared: required<string>(), childOnly: required<boolean>() },
    exit: { result: required<number>(), childOut: required<string>() },
    // @ts-expect-error Stage consumes response key foreignRs outside child space.
    stages: [consumesForeignRs],
    ending: childTerminal,
  });
  child.compose('reject-foreign-named-into-consumes', {
    entry: {},
    exit: {},
    stages: [],
    // @ts-expect-error Named into edge consumes request key foreignRq outside child space.
    ending: namedIntoConsumesForeignRq,
    targets: { peer: baseLeaf },
  });
  child.compose('reject-foreign-homogeneous-into-consumes', {
    entry: {},
    exit: {},
    stages: [],
    // @ts-expect-error Homogeneous into edge consumes request key foreignRq outside child space.
    ending: homogeneousIntoConsumesForeignRq,
    targets: { peer: baseLeaf },
  });

  // Bidirectional value-type check rejects narrower and wider spaces.
  const narrow = defineFacts<{ shared: 'only' }, { result: 1 }>();
  const narrowStage = narrow.defineStage({
    name: 'narrow-writer',
    request: { needs: {} },
    return: { provides: { result: required<1>() } },
    execute: async () => ({ result: 1 }),
  });
  base.compose('reject-narrow-writer', {
    entry: {},
    exit: { result: required<number>() },
    stages: [],
    // @ts-expect-error Stage response type 1 is not bidirectionally equal to number.
    ending: narrowStage,
  });

  // Stage positions are enforced statically.
  child.compose('reject-return-in-stages', {
    entry: { shared: required<string>(), childOnly: required<boolean>() },
    exit: { result: required<number>(), childOut: required<string>() },
    // @ts-expect-error A return-only stage cannot appear in stages.
    stages: [childTerminal],
    ending: childTerminal,
  });

  child.compose('reject-through-in-ending', {
    entry: { shared: required<string>() },
    exit: { result: required<number>() },
    stages: [],
    // @ts-expect-error A through stage cannot appear in ending.
    ending: parentStage,
  });
};

export const verifyParameterizedOpsAndCrossOpInto = (): void => {
  interface HttpHeaders { readonly entries: readonly [string, string][] }
  interface HttpRes { readonly status: number }
  interface UpstreamSnapshot { readonly id: string }
  interface ModelSnapshot { readonly name: string }
  interface Candidate { readonly upstream: UpstreamSnapshot; readonly model: ModelSnapshot }
  interface SelectedCandidate { readonly upstreamId: string; readonly model: string }
  interface ProtocolError { readonly kind: 'error'; readonly source: 'upstream' | 'local'; readonly error: unknown }
  interface ProtocolStream<E> { readonly kind: 'stream'; readonly stream: ManagedStream<E, string> }
  interface ProtocolResult<R> { readonly kind: 'result'; readonly result: R }

  interface Operations {
    anthropicMessages: { request: { anthropic: true }; outcome: ProtocolError | ProtocolStream<'a'> };
    openaiResponses: { request: { responses: true }; outcome: ProtocolError | ProtocolStream<'r'> };
    openaiEmbeddings: { request: { input: string }; outcome: ProtocolError | ProtocolResult<number[]> };
    rerank: { request: { query: string }; outcome: ProtocolError | ProtocolResult<string[]> };
  }
  type OpName = keyof Operations;
  type NonChatOp = 'openaiEmbeddings' | 'rerank';

  interface UpstreamServices { readonly fetchUpstream: (id: string) => Promise<HttpRes> }
  interface GatewayServices extends UpstreamServices { readonly recordMetric: (op: string) => void }

  interface UpstreamRequestFacts<Op extends OpName> {
    'http.headers': HttpHeaders;
    upstream: UpstreamSnapshot;
    model: ModelSnapshot;
    payload: Operations[Op]['request'];
  }
  interface UpstreamResponseFacts<Op extends OpName> {
    http: HttpRes | null;
    outcome: Operations[Op]['outcome'];
    usageModelKey: string;
  }
  interface GatewayPrivateRq {
    candidates: readonly Candidate[];
  }
  interface GatewayPrivateRs {
    candidate: SelectedCandidate;
  }

  const upstreamFactsFor = <Op extends OpName>() =>
    defineFacts<UpstreamRequestFacts<Op>, UpstreamResponseFacts<Op>, UpstreamServices>();

  const gatewayFactsFor = <Op extends OpName>() =>
    upstreamFactsFor<Op>().extend<GatewayPrivateRq, GatewayPrivateRs, GatewayServices>();

  // Generic stage factory over <Op> with mandatory ExactEqual <T> and transform().
  const createNonChatFailover = <Op extends NonChatOp>(op: Op) =>
    gatewayFactsFor<Op>().defineStage({
      name: `${op}.failover`,
      through: {
        request: {
          needs: { candidates: required<readonly Candidate[]>() },
          provides: {
            upstream: required<UpstreamSnapshot>(),
            model: required<ModelSnapshot>(),
          },
          consumes: ['candidates'],
        },
        response: {
          needs: {
            http: required<HttpRes | null>(),
            outcome: required<Operations[Op]['outcome']>(),
          },
          provides: {
            candidate: required<SelectedCandidate>(),
          },
          consumes: [],
        },
      },
      execute: transform(scope => {
        let selected: Candidate | undefined;
        return {
          request: ({ candidates, ...rest }) => {
            selected = candidates[0]!;
            return { ...rest, upstream: selected.upstream, model: selected.model };
          },
          response: back => {
            scope.services.recordMetric(op);
            const _outcome: Operations[Op]['outcome'] = back.outcome;
            void _outcome;
            return {
              ...back,
              candidate: { upstreamId: selected!.upstream.id, model: selected!.model.name },
            };
          },
        };
      }),
    });

  // Negative inside generic stage factory.
  const badGenericFactory = <Op extends NonChatOp>(op: Op) =>
    gatewayFactsFor<Op>().defineStage({
      name: `${op}.bad`,
      through: {
        request: emptySide,
        response: {
          needs: {
            // @ts-expect-error string does not match Operations[Op]['outcome'].
            outcome: required<string>(),
          },
          provides: {},
          consumes: [],
        },
      },
      execute: async (facts, scope) => await scope.next(facts),
    });

  // Homogeneous runtime plugin dispatch stage over <Op> targeting upstreamFactsFor<Op>().
  type UpstreamPipeline<Op extends OpName> = Pipeline<
    {
      readonly 'http.headers': HttpHeaders;
      readonly upstream: UpstreamSnapshot;
      readonly model: ModelSnapshot;
      readonly payload: Operations[Op]['request'];
    },
    {
      readonly http: HttpRes | null;
      readonly outcome: Operations[Op]['outcome'];
      readonly usageModelKey?: string;
    },
    UpstreamServices
  >;

  const createProviderDispatch = <Op extends OpName>(op: Op) =>
    gatewayFactsFor<Op>().defineStage({
      name: `${op}.dispatch`,
      request: {
        needs: {
          'http.headers': required<HttpHeaders>(),
          upstream: required<UpstreamSnapshot>(),
          model: required<ModelSnapshot>(),
          payload: required<Operations[Op]['request']>(),
        },
      },
      into: {
        target: upstreamFactsFor<Op>(),
        request: emptySide,
        response: {
          needs: {
            http: required<HttpRes | null>(),
            outcome: required<Operations[Op]['outcome']>(),
            usageModelKey: optional<string>(),
          },
          provides: {},
          consumes: [],
        },
      },
      execute: async (facts, scope) => {
        const provider = scope.into[facts.upstream.id]!;
        return await provider(facts);
      },
    });

  // Mounting a homogeneous runtime plugin map works without `as any`.
  const mountEmbeddings = (plugins: Readonly<Record<string, UpstreamPipeline<'openaiEmbeddings'>>>) =>
    gatewayFactsFor<'openaiEmbeddings'>().compose('embeddings.egress', {
      entry: {
        'http.headers': required<HttpHeaders>(),
        candidates: required<readonly Candidate[]>(),
        payload: required<Operations['openaiEmbeddings']['request']>(),
      },
      exit: {
        http: required<HttpRes | null>(),
        outcome: required<Operations['openaiEmbeddings']['outcome']>(),
        candidate: required<SelectedCandidate>(),
        usageModelKey: optional<string>(),
      },
      stages: [createNonChatFailover('openaiEmbeddings')],
      ending: createProviderDispatch('openaiEmbeddings'),
      targets: plugins,
    });

  // Mounting a wrong-Op plugin map is rejected statically.
  const mountWrongPlugins = (plugins: Readonly<Record<string, UpstreamPipeline<'rerank'>>>) =>
    gatewayFactsFor<'openaiEmbeddings'>().compose('embeddings.bad-plugins', {
      entry: {
        'http.headers': required<HttpHeaders>(),
        candidates: required<readonly Candidate[]>(),
        payload: required<Operations['openaiEmbeddings']['request']>(),
      },
      exit: {
        http: required<HttpRes | null>(),
        outcome: required<Operations['openaiEmbeddings']['outcome']>(),
        candidate: required<SelectedCandidate>(),
        usageModelKey: optional<string>(),
      },
      stages: [createNonChatFailover('openaiEmbeddings')],
      ending: createProviderDispatch('openaiEmbeddings'),
      // @ts-expect-error rerank plugins do not match openaiEmbeddings payload/outcome.
      targets: plugins,
    });

  // Cross-Op `into` with explicit `target` FactSpace.
  const anthropicFacts = gatewayFactsFor<'anthropicMessages'>();
  const responsesFacts = gatewayFactsFor<'openaiResponses'>();

  const anthropicRoute = anthropicFacts.defineStage({
    name: 'anthropic.route',
    request: {
      needs: {
        'http.headers': required<HttpHeaders>(),
        upstream: required<UpstreamSnapshot>(),
        model: required<ModelSnapshot>(),
        payload: required<{ anthropic: true }>(),
      },
    },
    into: {
      native: {
        request: emptySide,
        response: {
          needs: { http: required<HttpRes | null>(), outcome: required<Operations['anthropicMessages']['outcome']>() },
          provides: {},
          consumes: [],
        },
      },
      responses: {
        target: responsesFacts,
        request: {
          needs: { payload: required<{ anthropic: true }>() },
          provides: { payload: required<{ responses: true }>() },
          consumes: [],
        },
        response: {
          needs: { http: required<HttpRes | null>(), outcome: required<Operations['openaiResponses']['outcome']>() },
          provides: { outcome: required<Operations['anthropicMessages']['outcome']>() },
          consumes: [],
        },
      },
    },
    execute: async (facts, scope) => {
      const translated = await scope.into.responses({ ...facts, payload: { responses: true } });
      if (translated.outcome.kind === 'error') return { ...translated, outcome: translated.outcome };
      return {
        ...translated,
        outcome: { kind: 'error', source: 'local', error: 'demo' },
      };
    },
  });

  // Negative cross-Op `into` edge checks: target space rejects mismatched request.provides / response.needs.
  anthropicFacts.defineStage({
    name: 'anthropic.route.bad-target-request',
    // @ts-expect-error Target space requires { responses: true } for payload, not { anthropic: true }.
    request: { needs: { payload: required<{ anthropic: true }>() } },
    // @ts-expect-error Target space rejects mismatched payload type on into edge.
    into: {
      responses: {
        target: responsesFacts,
        request: {
          needs: { payload: required<{ anthropic: true }>() },
          provides: { payload: required<{ anthropic: true }>() },
          consumes: [],
        },
        response: {
          needs: { outcome: required<Operations['openaiResponses']['outcome']>() },
          provides: { outcome: required<Operations['anthropicMessages']['outcome']>() },
          consumes: [],
        },
      },
    },
    execute: async () => ({}),
  });

  anthropicFacts.defineStage({
    name: 'anthropic.route.bad-target-response',
    // @ts-expect-error Target space requires openaiResponses outcome for response.needs.
    request: { needs: { payload: required<{ anthropic: true }>() } },
    // @ts-expect-error Target space rejects mismatched outcome type on into edge.
    into: {
      responses: {
        target: responsesFacts,
        request: {
          needs: { payload: required<{ anthropic: true }>() },
          provides: { payload: required<{ responses: true }>() },
          consumes: [],
        },
        response: {
          needs: { outcome: required<Operations['anthropicMessages']['outcome']>() },
          provides: { outcome: required<Operations['anthropicMessages']['outcome']>() },
          consumes: [],
        },
      },
    },
    execute: async () => ({}),
  });

  const anthropicEgress = anthropicFacts.compose('anthropic.egress', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      upstream: required<UpstreamSnapshot>(),
      model: required<ModelSnapshot>(),
      payload: required<{ anthropic: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['anthropicMessages']['outcome']>(),
      usageModelKey: optional<string>(),
    },
    stages: [],
    ending: createProviderDispatch('anthropicMessages'),
    targets: {},
  });

  const responsesEgress = responsesFacts.compose('responses.egress', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      upstream: required<UpstreamSnapshot>(),
      model: required<ModelSnapshot>(),
      payload: required<{ responses: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['openaiResponses']['outcome']>(),
      usageModelKey: optional<string>(),
    },
    stages: [],
    ending: createProviderDispatch('openaiResponses'),
    targets: {},
  });

  anthropicFacts.compose('anthropic.body', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      upstream: required<UpstreamSnapshot>(),
      model: required<ModelSnapshot>(),
      payload: required<{ anthropic: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['anthropicMessages']['outcome']>(),
      usageModelKey: optional<string>(),
    },
    stages: [],
    ending: anthropicRoute,
    targets: { native: anthropicEgress, responses: responsesEgress },
  });

  anthropicFacts.compose('anthropic.body.swapped-targets', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      upstream: required<UpstreamSnapshot>(),
      model: required<ModelSnapshot>(),
      payload: required<{ anthropic: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['anthropicMessages']['outcome']>(),
      usageModelKey: optional<string>(),
    },
    stages: [],
    ending: anthropicRoute,
    targets: {
      // @ts-expect-error responsesEgress does not accept anthropicMessages payload.
      native: responsesEgress,
      // @ts-expect-error anthropicEgress does not accept openaiResponses payload.
      responses: anthropicEgress,
    },
  });

  // Covariant closed Pipeline<I, O, S> (out IK, out OK) for opaque provider plugins.
  interface ClaudePrivateRq { 'claude.token': string }
  interface ClaudePrivateRs { 'claude.rateLimit': number }
  interface ClaudePrivateServices extends UpstreamServices { readonly tokenStore: () => string }

  const claudeSpace = upstreamFactsFor<'openaiResponses'>().extend<ClaudePrivateRq, ClaudePrivateRs>();
  const claudeOmitUsage = claudeSpace.compose('claude.omit', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      payload: required<{ responses: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['openaiResponses']['outcome']>(),
    },
    stages: [],
    ending: claudeSpace.defineStage({
      name: 'claude.omit.end',
      request: { needs: { 'http.headers': required<HttpHeaders>(), payload: required<{ responses: true }>() } },
      return: { provides: { http: required<HttpRes | null>(), outcome: required<Operations['openaiResponses']['outcome']>() } },
      execute: async () => ({ http: null, outcome: { kind: 'error', source: 'local', error: 'demo' } }),
    }),
  });
  const okSubsetPlugin: UpstreamPipeline<'openaiResponses'> = claudeOmitUsage;

  const claudeReqUsage = claudeSpace.compose('claude.req-usage', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      upstream: required<UpstreamSnapshot>(),
      model: required<ModelSnapshot>(),
      payload: required<{ responses: true }>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['openaiResponses']['outcome']>(),
      usageModelKey: required<string>(),
    },
    stages: [],
    ending: claudeSpace.defineStage({
      name: 'claude.req-usage.end',
      request: {
        needs: {
          'http.headers': required<HttpHeaders>(),
          upstream: required<UpstreamSnapshot>(),
          model: required<ModelSnapshot>(),
          payload: required<{ responses: true }>(),
        },
      },
      return: {
        provides: {
          http: required<HttpRes | null>(),
          outcome: required<Operations['openaiResponses']['outcome']>(),
          usageModelKey: required<string>(),
        },
      },
      execute: async () => ({ http: null, outcome: { kind: 'error', source: 'local', error: 'demo' }, usageModelKey: 'm' }),
    }),
  });
  const okNarrowExitPlugin: UpstreamPipeline<'openaiResponses'> = claudeReqUsage;

  const claudeBadOptEntry = claudeSpace.compose('claude.bad-opt-entry', {
    entry: {
      'http.headers': required<HttpHeaders>(),
      'claude.token': optional<string>(),
    },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['openaiResponses']['outcome']>(),
    },
    stages: [],
    ending: claudeSpace.defineStage({
      name: 'claude.bad-opt-entry.end',
      request: { needs: { 'http.headers': required<HttpHeaders>(), 'claude.token': optional<string>() } },
      return: { provides: { http: required<HttpRes | null>(), outcome: required<Operations['openaiResponses']['outcome']>() } },
      execute: async () => ({ http: null, outcome: { kind: 'error', source: 'local', error: 'demo' } }),
    }),
  });
  // @ts-expect-error Private optional entry key cannot cross the closed plugin boundary.
  const rejectOptEntry: UpstreamPipeline<'openaiResponses'> = claudeBadOptEntry;

  const claudeLeakExit = claudeSpace.compose('claude.leak-exit', {
    entry: { 'http.headers': required<HttpHeaders>() },
    exit: {
      http: required<HttpRes | null>(),
      outcome: required<Operations['openaiResponses']['outcome']>(),
      'claude.rateLimit': optional<number>(),
    },
    stages: [],
    ending: claudeSpace.defineStage({
      name: 'claude.leak-exit.end',
      request: { needs: { 'http.headers': required<HttpHeaders>() } },
      return: {
        provides: {
          http: required<HttpRes | null>(),
          outcome: required<Operations['openaiResponses']['outcome']>(),
          'claude.rateLimit': optional<number>(),
        },
      },
      execute: async () => ({ http: null, outcome: { kind: 'error', source: 'local', error: 'demo' } }),
    }),
  });
  // @ts-expect-error Private exit key cannot leak past closed plugin output key set.
  const rejectLeakExit: UpstreamPipeline<'openaiResponses'> = claudeLeakExit;

  const claudeBadServices = upstreamFactsFor<'openaiResponses'>().extend<object, object, ClaudePrivateServices>();
  const badSvcPlugin = claudeBadServices.compose('claude.bad-svc', {
    entry: { 'http.headers': required<HttpHeaders>() },
    exit: { http: required<HttpRes | null>(), outcome: required<Operations['openaiResponses']['outcome']>() },
    stages: [],
    ending: claudeBadServices.defineStage({
      name: 'claude.bad-svc.end',
      request: { needs: { 'http.headers': required<HttpHeaders>() } },
      return: { provides: { http: required<HttpRes | null>(), outcome: required<Operations['openaiResponses']['outcome']>() } },
      execute: async (_facts, scope) => {
        scope.services.tokenStore();
        return { http: null, outcome: { kind: 'error', source: 'local', error: 'demo' } };
      },
    }),
  });
  // @ts-expect-error UpstreamServices does not satisfy ClaudePrivateServices.
  const rejectBadSvc: UpstreamPipeline<'openaiResponses'> = badSvcPlugin;

  void [badGenericFactory, mountEmbeddings, mountWrongPlugins, okSubsetPlugin, okNarrowExitPlugin, rejectOptEntry, rejectLeakExit, rejectBadSvc];
};

export const verifyNoBlindOptionalPassthroughAndConsumption = (): void => {
  type OuterRq = { seed: number; label: number; wsId: string };
  type InnerRq = { seed: number; label: string; wsId: string };
  type Rs = { delivered: number };

  const outer = defineFacts<OuterRq, Rs>();
  const inner = defineFacts<InnerRq, Rs>();

  const innerTarget = inner.compose('inner-target', {
    entry: { seed: required<number>(), wsId: optional<string>() },
    exit: { delivered: required<number>() },
    stages: [],
    ending: inner.defineStage({
      name: 'inner-end',
      request: { needs: { seed: required<number>(), wsId: optional<string>() } },
      return: { provides: { delivered: required<number>() } },
      execute: async ({ seed, wsId }) => ({ delivered: seed + (wsId?.length ?? 0) }),
    }),
  });

  const relay = outer.defineStage({
    name: 'relay',
    request: { needs: { seed: required<number>() } },
    into: { target: { request: emptySide, response: { needs: { delivered: required<number>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });

  outer.compose('reject-blind-optional', {
    entry: { seed: required<number>() },
    exit: { delivered: required<number>() },
    stages: [],
    ending: relay,
    // @ts-expect-error Target optional entry key wsId is neither declared nor provided by caller.
    targets: { target: innerTarget },
  });

  const labelTarget = inner.compose('label-target', {
    entry: { label: optional<string>() },
    exit: { delivered: required<number>() },
    stages: [],
    ending: inner.defineStage({
      name: 'label-end',
      request: { needs: { label: optional<string>() } },
      return: { provides: { delivered: required<number>() } },
      execute: async ({ label }) => ({ delivered: label?.length ?? 0 }),
    }),
  });

  const consumeLabel = outer.defineStage({
    name: 'consume-label',
    through: {
      request: { needs: { label: optional<number>() }, provides: {}, consumes: ['label'] },
      response: { needs: { delivered: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async ({ label: _, ...rest }, scope) => await scope.next(rest),
  });

  const restoreLabel = outer.defineStage({
    name: 'restore-label',
    through: {
      request: { needs: {}, provides: { label: optional<number>() }, consumes: [] },
      response: { needs: { delivered: required<number>() }, provides: {}, consumes: [] },
    },
    execute: async (facts, scope) => await scope.next({ ...facts, label: 17 }),
  });

  const bareRelay = outer.defineStage({
    name: 'bare-relay',
    request: { needs: {} },
    into: { target: { request: emptySide, response: { needs: { delivered: required<number>() }, provides: {}, consumes: [] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });

  // Consuming label makes it provably absent at the into boundary.
  outer.compose('consumed-optional-ok', {
    entry: { label: optional<number>() },
    exit: { delivered: required<number>() },
    stages: [consumeLabel],
    ending: bareRelay,
    targets: { target: labelTarget },
  });

  // Optionally restoring label reintroduces incompatible number type.
  outer.compose('optional-restore-rejected', {
    entry: { label: optional<number>() },
    exit: { delivered: required<number>() },
    stages: [consumeLabel, restoreLabel],
    ending: bareRelay,
    // @ts-expect-error Optional restore reintroduces number for target's optional string label.
    targets: { target: labelTarget },
  });

  // Widened stage array cannot prove consumption statically.
  const widened: readonly (typeof consumeLabel)[] = [consumeLabel];
  outer.compose('widened-stages-rejected', {
    entry: { label: optional<number>() },
    exit: { delivered: required<number>() },
    stages: widened,
    ending: bareRelay,
    // @ts-expect-error Widened array type cannot guarantee consumeLabel runs.
    targets: { target: labelTarget },
  });
};

export const verifyTargetOutputAndKeyInventory = (): void => {
  const numeric = defineFacts<object, { value: number; metadata: number }>();
  const textual = defineFacts<object, { value: string; output: string }>();

  const valueTarget = numeric.compose('value', {
    entry: {},
    exit: { value: required<number>() },
    stages: [],
    ending: numeric.defineStage({
      name: 'value',
      request: { needs: {} },
      return: { provides: { value: required<number>() } },
      execute: async () => ({ value: 42 }),
    }),
  });
  const relay = textual.defineStage({
    name: 'relay',
    request: { needs: {} },
    into: { target: { request: emptySide, response: emptySide } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });

  textual.compose('bad-public-exit', {
    entry: {},
    exit: { value: required<string>() },
    stages: [],
    ending: relay,
    // @ts-expect-error Numeric value cannot pass through to textual public exit.
    targets: { target: valueTarget },
  });

  const consumer = textual.defineStage({
    name: 'text-consumer',
    through: {
      request: emptySide,
      response: { needs: { value: required<string>() }, provides: { output: required<string>() }, consumes: ['value'] },
    },
    execute: async (facts, scope) => {
      const { value, ...rest } = await scope.next(facts);
      return { ...rest, output: value.toUpperCase() };
    },
  });

  textual.compose('bad-downstream-consumer', {
    entry: {},
    exit: { output: required<string>() },
    stages: [consumer],
    ending: relay,
    // @ts-expect-error Numeric value cannot pass through to textual downstream stage.
    targets: { target: valueTarget },
  });

  // Pipeline key inventory prevents erasing required/optional outputs or optional inputs.
  type Req = { seed: number; label: string };
  type Res = { value: number; note: string };
  const inv = defineFacts<Req, Res>();
  const full = inv.compose('full', {
    entry: { seed: required<number>(), label: optional<string>() },
    exit: { value: required<number>(), note: optional<string>() },
    stages: [],
    ending: inv.defineStage({
      name: 'full-end',
      request: { needs: { seed: required<number>(), label: optional<string>() } },
      return: { provides: { value: required<number>(), note: optional<string>() } },
      execute: async ({ seed, label }) => ({ value: seed, ...(label !== undefined && { note: label }) }),
    }),
  });
  // @ts-expect-error Cannot erase required output key.
  const eraseRequired: Pipeline<{ seed: number; label?: string }, object> = full;
  // @ts-expect-error Cannot erase optional output key.
  const eraseOptional: Pipeline<{ seed: number; label?: string }, { value: number }> = full;
  // @ts-expect-error Cannot erase optional input key.
  const eraseInput: Pipeline<{ seed: number }, { value: number; note?: string }> = full;
  const safeSubtypes: Pipeline<{ seed: 1; label?: string }, { value: number; note?: string | number }> = full;
  void [eraseRequired, eraseOptional, eraseInput, safeSubtypes];
};

export const verifyScopeHierarchyAndPolymorphicProducer = (): void => {
  interface Svc { readonly tag: string }
  const space = defineFacts<{ round: number }, { stream: ManagedStream<number, never> }, Svc>();

  // Polymorphic `this` preserves `next` inside `StageScope`'s stream/deferred producers.
  const stage = space.defineStage({
    name: 'poly-producer',
    through: {
      request: { needs: { round: required<number>() }, provides: { round: required<number>() }, consumes: [] },
      response: { needs: { stream: required<ManagedStream<number, never>>() }, provides: { stream: required<ManagedStream<number, never>>() }, consumes: [] },
    },
    execute: async (facts, scope) => {
      const asStage: StageScope<
        Svc,
        <Actual extends { readonly round: number }>(req: Actual) => Promise<{ readonly stream: ManagedStream<number, never> }>
      > = scope;
      const asProducer: ProducerScope<Svc> = scope;
      const asHost: HostScope = scope;
      const asWorker: WorkerScope<Svc> = scope;
      void [asStage, asProducer, asHost, asWorker];

      // @ts-expect-error StageScope does not expose close().
      scope.close();
      // @ts-expect-error HostScope does not expose close().
      asHost.close();
      // @ts-expect-error HostScope does not expose services.
      void asHost.services;
      // @ts-expect-error HostScope does not expose detach.
      void asHost.detach;
      // @ts-expect-error WorkerScope does not expose signal.
      void asWorker.signal;
      // @ts-expect-error WorkerScope does not expose run.
      void asWorker.run;

      const first = scope.next(facts);
      const back = await first;
      const wrapped = scope.wrapStream(back.stream, async function* (inner, producer) {
        yield* producer.read(inner);
        const second = producer.next({ ...facts, round: facts.round + 1 });
        const secondAnswer = await second;
        yield* producer.read(secondAnswer.stream);
        producer.discard(second);
      });
      scope.createStream(async function* (producer) {
        const call = producer.next({ ...facts, round: 99 });
        producer.abort(call).discard();
        yield { ok: true, value: 1 } as const;
      });
      asProducer.createStream(async function* (producer) {
        // @ts-expect-error Plain ProducerScope does not have next.
        void producer.next;
        yield { ok: true, value: 1 } as const;
      });
      return { ...back, stream: wrapped };
    },
  });

  // RootHostScope exposes close(), enforces checked Entry, explicit services, and exactOptionalPropertyTypes.
  const hostSpace = defineFacts<{ label: string }, { label: number }, Svc>();
  const term = hostSpace.defineStage({
    name: 'term',
    request: { needs: { label: optional<string>() } },
    return: { provides: { label: optional<number>() } },
    execute: async ({ label }) => ({ ...(label !== undefined && { label: label.length }) }),
  });
  const unchecked = hostSpace.compose('term', {
    entry: { label: optional<string>() },
    exit: { label: optional<number>() },
    stages: [],
    ending: term,
  });
  const checked = asEntry(unchecked);
  const { host, services } = hostFor<Svc>({ tag: 'ok' });
  const rootHost: RootHostScope = host;
  const hostOnly: HostScope = createHostScope({ signal: new AbortController().signal, waitUntil: () => undefined });
  // @ts-expect-error HostScope does not expose close().
  hostOnly.close();
  rootHost.close();

  // @ts-expect-error Unchecked pipeline cannot be passed to host.run.
  void host.run(unchecked, {}, { services });
  // @ts-expect-error Services must be passed explicitly.
  void host.run(checked, {});
  // @ts-expect-error Services must satisfy entry service contract.
  void host.run(checked, {}, { services: {} });
  // @ts-expect-error exactOptionalPropertyTypes forbids explicit undefined for optional keys.
  void host.run(checked, { label: undefined }, { services });
  const okAnswer: Promise<{ readonly label?: number }> = host.run(checked, { label: 'hi' }, { services });

  // Polymorphic `this` also preserves `into` inside `StageScope<S, never, Into>` producers.
  const intoPoly = space.defineStage({
    name: 'poly-into-producer',
    request: { needs: { round: required<number>() } },
    into: {
      peer: {
        request: emptySide,
        response: { needs: { stream: required<ManagedStream<number, never>>() }, provides: {}, consumes: [] },
      },
    },
    return: { provides: { stream: required<ManagedStream<number, never>>() } },
    execute: async (facts, scope) => ({
      stream: scope.createStream(async function* (producer) {
        const peerCall = producer.into.peer(facts);
        const peerBack = await peerCall;
        yield* producer.read(peerBack.stream);
        producer.discard(peerCall);
      }),
    }),
  });
  void [stage, okAnswer, intoPoly];
};
