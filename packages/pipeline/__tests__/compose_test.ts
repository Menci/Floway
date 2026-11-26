import { expect, it } from 'vitest';

import { emptySide, hostFor } from './run-fixture.ts';
import { asEntry, factSpace, run, transform } from '../src/index.ts';
import type { Entry, Pipeline } from '../src/index.ts';

it('resolves a reachable cycle synchronously through forward and direct target definitions', async () => {
  type Request = { value: number; forward: boolean };
  type Response = { value: string };
  const { defineStage, compose } = factSpace<Request, Response>();
  const checks: string[] = [];
  const execution: string[] = [];
  const ending = (name: string) => defineStage({
    name,
    request: { needs: ['value', 'forward'] },
    into: {
      peer: {
        request: { ...emptySide, needs: ['value', 'forward'], provides: ['forward'] },
        response: { ...emptySide, needs: ['value'] },
      },
    },
    return: { provides: ['value'] },
    execute: async (facts, scope) => {
      execution.push(name);
      if (facts.forward) return await scope.into.peer({ ...facts, forward: false });
      return { value: `${name}:${facts.value}` };
    },
  });
  const responses: Pipeline<Request, Response> = compose('openaiResponses', {
    entry: ['value', 'forward'], exit: ['value'], stages: [], ending: ending('openaiResponses'),
    targets: { peer: () => { checks.push('anthropicMessages'); return messages; } },
  });
  const messages = compose('anthropicMessages', {
    entry: ['value', 'forward'], exit: ['value'], stages: [], ending: ending('anthropicMessages'),
    targets: { peer: responses },
  });
  expect(checks).toEqual([]);
  const entry = asEntry(responses);
  expect(checks).toEqual(['anthropicMessages']);
  expect(execution).toEqual([]);
  const host = hostFor({});
  const running = run(entry, { forward: true, value: 3 }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ value: 'anthropicMessages:3' });
  expect(execution).toEqual(['openaiResponses', 'anthropicMessages']);
  asEntry(messages);
  expect(checks).toEqual(['anthropicMessages']);
  host.controller.abort();
  running.discard(answer);
});

it('rejects a reachable missing request key before an unchecked ingress can execute', () => {
  type Request = { required: number; shared: number };
  type Response = { answer: string };
  const { defineStage, compose } = factSpace<Request, Response>();
  const execution: string[] = [];
  const first = defineStage({
    name: 'first',
    request: { needs: ['shared'] },
    into: { peer: { request: emptySide, response: { ...emptySide, needs: ['answer'] } } },
    execute: async (facts, scope) => {
      execution.push('first');
      return await scope.into.peer(facts);
    },
  });
  const second = defineStage({
    name: 'second',
    request: { needs: ['shared', 'required'] },
    into: { peer: { request: emptySide, response: { ...emptySide, needs: ['answer'] } } },
    return: { provides: ['answer'] },
    execute: async () => {
      execution.push('second');
      return { answer: 'reachable' };
    },
  });
  const body: Pipeline<{ shared: number }, Response> = compose('body', {
    entry: ['shared'], exit: ['answer'], stages: [], ending: first, targets: { peer: () => peer },
  });
  const peer = compose('peer', {
    entry: ['shared', 'required'], exit: ['answer'], stages: [], ending: second, targets: { peer: body },
  });
  expect(() => asEntry(body)).toThrow('body into "peer" request does not guarantee "required"');
  const forged = body as Entry<{ shared: number }, Response>;
  expect(() => run(forged, { shared: 1 }, hostFor({}).options)).toThrow('Expected a checked entry for pipeline "body"');
  expect(execution).toEqual([]);
});

it('checks declared entry and exit keys and required paths during module assembly', () => {
  type Request = { request: number; alternative: number };
  type Response = { response: number; alternative: number };
  const { defineStage, compose } = factSpace<Request, Response>();
  const terminal = defineStage({
    name: 'terminal', request: { needs: ['request'] }, return: { provides: ['response'] },
    execute: async facts => ({ response: facts.request }),
  });
  expect(() => compose('bad-entry', {
    entry: ['alternative'], exit: ['response'], stages: [], ending: terminal,
  })).toThrow('bad-entry entry disagrees with the stages');
  expect(() => compose('bad-exit', {
    entry: ['request'], exit: ['alternative'], stages: [], ending: terminal,
  })).toThrow('bad-exit exit disagrees with the stages');

  const consume = defineStage({
    name: 'consume',
    through: { request: { ...emptySide, needs: ['request'], consumes: ['request'] }, response: emptySide },
    execute: async ({ request: _, ...rest }, scope) => await scope.next(rest),
  });
  expect(() => compose('after-consume', {
    entry: ['request'], exit: ['response'], stages: [consume], ending: terminal,
  })).toThrow('terminal requires "request" after it was consumed');

  const short = defineStage({
    name: 'short',
    through: { request: emptySide, response: emptySide },
    return: { provides: ['alternative'] },
    execute: async () => ({ alternative: 1 }),
  });
  const requiresResponse = defineStage({
    name: 'requires-response',
    through: { request: emptySide, response: { ...emptySide, needs: ['response'] } },
    execute: async (facts, scope) => await scope.next(facts),
  });
  expect(() => compose('uncovered', {
    entry: ['request'], exit: ['response'], stages: [requiresResponse, short], ending: terminal,
  })).toThrow('requires-response child response does not guarantee "response"');
});

it('reuses compatible declared stage values in a larger space and passes the extra facts through', async () => {
  type Request = { same: string };
  type Response = { same: number };
  const base = factSpace<Request, Response>();
  const extended = factSpace<Request & { other: number }, Response & { extra: string }>();
  const reusable = base.defineStage({
    name: 'reusable',
    through: { request: { ...emptySide, needs: ['same'] }, response: { ...emptySide, needs: ['same'] } },
    execute: async (facts, scope) => await scope.next(facts),
  });
  const terminal = extended.defineStage({
    name: 'extended', request: { needs: ['same', 'other'] }, return: { provides: ['same', 'extra'] },
    execute: async facts => ({ same: facts.other, extra: facts.same }),
  });
  const entry = asEntry(extended.compose('extended', {
    entry: ['same', 'other'], exit: ['same', 'extra'], stages: [reusable], ending: terminal,
  }));
  const host = hostFor({});
  const running = run(entry, { same: 'request', other: 2 }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ same: 2, extra: 'request' });
  host.controller.abort();
  running.discard(answer);
});

it('enters a target with a compatible optional entry key absent from the request', async () => {
  type Request = { payload: string; surcharge: number };
  type Response = { size: number };
  const outer = factSpace<Request, Response>();
  const inner = factSpace<Request, Response>();
  const calculator = inner.defineStage({
    name: 'calculator', request: { needs: ['payload', 'surcharge?'] }, return: { provides: ['size'] },
    execute: async ({ payload, surcharge }) => ({ size: payload.length + (surcharge ?? 0) }),
  });
  const target = inner.compose('target', {
    entry: ['payload', 'surcharge?'], exit: ['size'], stages: [], ending: calculator,
  });
  const relay = outer.defineStage({
    name: 'relay', request: { needs: ['payload'] },
    into: {
      target: {
        request: { ...emptySide, needs: ['surcharge?'] },
        response: { ...emptySide, needs: ['size'] },
      },
    },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const entry = asEntry(outer.compose('relay', {
    entry: ['payload', 'surcharge?'], exit: ['size'], stages: [], ending: relay, targets: { target },
  }));
  const host = hostFor({});
  const running = run(entry, { payload: 'input' }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ size: 5 });
  host.controller.abort();
  running.discard(answer);
});

it.each([false, true])('rejects an untyped optional target key even with an optional provider (provider=%s)', withProvider => {
  const { defineStage, compose } = factSpace<{ seed: number; label: string }, { delivered: number }>();
  const execution: string[] = [];
  const terminal = defineStage({
    name: 'terminal', request: { needs: ['label?'] }, return: { provides: ['delivered'] },
    execute: async ({ label }) => {
      execution.push('terminal');
      return { delivered: label?.length ?? 0 };
    },
  });
  const target = compose('target', { entry: ['label?'], exit: ['delivered'], stages: [], ending: terminal });
  const provider = defineStage({
    name: 'optional-provider',
    through: {
      request: { ...emptySide, needs: ['seed'], provides: ['label?'] },
      response: { ...emptySide, needs: ['delivered'] },
    },
    execute: async (facts, scope) => await scope.next(facts),
  });
  const relay = defineStage({
    name: 'relay', request: { needs: ['seed'] },
    into: { target: { request: emptySide, response: { ...emptySide, needs: ['delivered'] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const outer = compose('outer', {
    entry: ['seed'], exit: ['delivered'], stages: withProvider ? [provider] : [], ending: relay, targets: { target },
  });
  expect(() => asEntry(outer)).toThrow('outer into "target" request does not declare a typed source for optional target key "label"');
  expect(execution).toEqual([]);
});

it('derives a typed optional entry key despite an earlier conditional provision', async () => {
  const { defineStage, compose } = factSpace<{ label: string }, { delivered: string }>();
  const extra = { value: 42 };
  const terminal = defineStage({
    name: 'terminal', request: { needs: ['label?'] }, return: { provides: ['delivered'] },
    execute: async facts => {
      expect(Object.getOwnPropertyDescriptor(facts, 'extra')?.value).toBe(extra);
      return { delivered: facts.label?.toUpperCase() ?? 'absent' };
    },
  });
  const target = compose('target', { entry: ['label?'], exit: ['delivered'], stages: [], ending: terminal });
  const provider = defineStage({
    name: 'optional-provider',
    through: { request: { ...emptySide, provides: ['label?'] }, response: { ...emptySide, needs: ['delivered'] } },
    execute: async (facts, scope) => await scope.next(facts),
  });
  const relay = defineStage({
    name: 'relay', request: { needs: [] },
    into: {
      target: {
        request: { ...emptySide, needs: ['label?'] },
        response: { ...emptySide, needs: ['delivered'] },
      },
    },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const body = { exit: ['delivered'], stages: [provider], ending: relay, targets: { target } } as const;
  expect(() => compose('missing-label', { ...body, entry: [] })).toThrow('missing-label entry disagrees with the stages on "label"');
  const entry = asEntry(compose('typed-label', { ...body, entry: ['label?'] }));
  const host = hostFor({});
  const request = { label: 'correct', extra };
  const running = run(entry, request, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ delivered: 'CORRECT' });
  host.controller.abort();
  running.discard(answer);
});

it('allows an edge to consume an optional request key that the target types differently', async () => {
  type Response = { delivered: string };
  const outer = factSpace<{ label: number }, Response>();
  const inner = factSpace<{ label: string }, Response>();
  const terminal = inner.defineStage({
    name: 'textual-label', request: { needs: ['label?'] }, return: { provides: ['delivered'] },
    execute: async facts => ({ delivered: Object.hasOwn(facts, 'label') ? facts.label!.toUpperCase() : 'absent' }),
  });
  const target = inner.compose('target', { entry: ['label?'], exit: ['delivered'], stages: [], ending: terminal });
  const relay = outer.defineStage({
    name: 'strip-label', request: { needs: ['label?'] },
    into: {
      target: {
        request: { ...emptySide, needs: ['label?'], consumes: ['label'] },
        response: { ...emptySide, needs: ['delivered'] },
      },
    },
    execute: async ({ label: _, ...rest }, scope) => await scope.into.target(rest),
  });
  const entry = asEntry(outer.compose('strip-label', {
    entry: ['label?'], exit: ['delivered'], stages: [], ending: relay, targets: { target },
  }));
  const host = hostFor({});
  const running = run(entry, { label: 17 }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ delivered: 'absent' });
  host.controller.abort();
  running.discard(answer);
});

it('allows a through stage to consume an optional request key before an into boundary', async () => {
  type Response = { delivered: string };
  const outer = factSpace<{ label: number }, Response>();
  const inner = factSpace<{ label: string }, Response>();
  const source = inner.defineStage({
    name: 'textual-label', request: { needs: ['label?'] }, return: { provides: ['delivered'] },
    execute: async ({ label }) => ({ delivered: label === undefined ? 'absent' : label.toUpperCase() }),
  });
  const target = inner.compose('target', { entry: ['label?'], exit: ['delivered'], stages: [], ending: source });
  const consume = outer.defineStage({
    name: 'consume-label',
    through: {
      request: { ...emptySide, needs: ['label?'], consumes: ['label'] },
      response: { ...emptySide, needs: ['delivered'] },
    },
    execute: async ({ label: _, ...rest }, scope) => await scope.next(rest),
  });
  const relay = outer.defineStage({
    name: 'relay', request: { needs: [] },
    into: { target: { request: emptySide, response: { ...emptySide, needs: ['delivered'] } } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const entry = asEntry(outer.compose('strip-label', {
    entry: ['label?'], exit: ['delivered'], stages: [consume], ending: relay, targets: { target },
  }));
  const host = hostFor({});
  const running = run(entry, { label: 17 }, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ delivered: 'absent' });
  host.controller.abort();
  running.discard(answer);
});

it('rejects an own key leaked from a nested exit before an optional outer consumer can read it', async () => {
  const numeric = factSpace<object, { value: number }>();
  const textual = factSpace<object, { value: string }>();
  const completed: string[] = [];
  const supply = numeric.defineStage({
    name: 'supply-number', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => {
      completed.push('numeric');
      return Object.defineProperty({ value: 42 }, 'value', { enumerable: false });
    },
  });
  const empty = numeric.defineStage({
    name: 'empty', request: { needs: [] }, return: { provides: [] },
    execute: async () => { completed.push('empty'); return {}; },
  });
  const closed = numeric.defineStage({
    name: 'mixed', request: { needs: [] },
    into: {
      value: { request: emptySide, response: { ...emptySide, consumes: ['value'] } },
      empty: { request: emptySide, response: emptySide },
    },
    execute: async (facts, scope) => {
      await scope.into.empty(facts);
      return await scope.into.value(facts);
    },
  });
  const nested = numeric.compose('nested', {
    entry: [], exit: [], stages: [], ending: closed,
    targets: {
      value: numeric.compose('value', { entry: [], exit: ['value'], stages: [], ending: supply }),
      empty: numeric.compose('empty', { entry: [], exit: [], stages: [], ending: empty }),
    },
  });
  const relay = textual.defineStage({
    name: 'relay', request: { needs: [] },
    into: { nested: { request: emptySide, response: { ...emptySide, needs: ['value?'] } } },
    execute: async (facts, scope) => {
      const answer = await scope.into.nested(facts);
      completed.push('outer consumer');
      answer.value?.toUpperCase();
      return answer;
    },
  });
  const entry = asEntry(textual.compose('outer', { entry: [], exit: [], stages: [], ending: relay, targets: { nested } }));
  const host = hostFor({});
  await expect(run(entry, {}, host.options).result).rejects.toThrow('Pipeline "nested" exit returned undeclared "value"');
  expect(completed).toEqual(['empty', 'numeric']);
  host.controller.abort();
});

it('allows an incompatible target value that a stage always replaces on the response path', async () => {
  const numeric = factSpace<object, { value: number }>();
  const textual = factSpace<object, { value: string }>();
  const source = numeric.defineStage({
    name: 'supply-number', request: { needs: [] }, return: { provides: ['value'] },
    execute: async () => ({ value: 42 }),
  });
  const target = numeric.compose('target', { entry: [], exit: ['value'], stages: [], ending: source });
  const relay = textual.defineStage({
    name: 'relay', request: { needs: [] }, into: { target: { request: emptySide, response: emptySide } },
    execute: async (facts, scope) => await scope.into.target(facts),
  });
  const overwrite = textual.defineStage({
    name: 'write-text', through: { request: emptySide, response: { ...emptySide, provides: ['value'] } },
    execute: async (facts, scope) => ({ ...await scope.next(facts), value: 'replacement' }),
  });
  const entry = asEntry(textual.compose('replacement', {
    entry: [], exit: ['value'], stages: [overwrite], ending: relay, targets: { target },
  }));
  const host = hostFor({});
  const running = run(entry, {}, host.options);
  const answer = await running.result;
  expect(answer).toEqual({ value: 'replacement' });
  host.controller.abort();
  running.discard(answer);
});

it('keeps a caller’s original request when both directions use the same key with separate types', async () => {
  type Request = { http: { url: string } };
  type Response = { http: { status: number } };
  const { defineStage, compose } = factSpace<Request, Response>();
  const sent: string[] = [];
  const received: [string | undefined, number][] = [];
  const terminal = defineStage({
    name: 'terminal', request: { needs: ['http'] }, return: { provides: ['http'] },
    execute: async ({ http }) => {
      sent.push(http.url);
      return { http: { status: 218 } };
    },
  });
  const rewrite = defineStage({
    name: 'rewrite',
    through: {
      request: { ...emptySide, needs: ['http'], provides: ['http'] },
      response: { ...emptySide, needs: ['http'] },
    },
    execute: async (facts, scope) => await scope.next({ ...facts, http: { url: `${facts.http.url}/rewritten` } }),
  });
  const caller = defineStage({
    name: 'caller',
    through: { request: { ...emptySide, needs: ['http'] }, response: { ...emptySide, needs: ['http'] } },
    execute: transform(() => {
      let original: Request['http'] | undefined;
      return {
        request: facts => { original = facts.http; return facts; },
        response: back => { received.push([original?.url, back.http.status]); return back; },
      };
    }),
  });
  const entry = asEntry(compose('directional', { entry: ['http'], exit: ['http'], stages: [caller, rewrite], ending: terminal }));
  const firstHost = hostFor({});
  const secondHost = hostFor({});
  const firstRequest = { http: { url: '/first' } };
  const first = run(entry, firstRequest, firstHost.options);
  const second = run(entry, { http: { url: '/second' } }, secondHost.options);
  const [firstAnswer, secondAnswer] = await Promise.all([first.result, second.result]);
  expect(sent).toEqual(['/first/rewritten', '/second/rewritten']);
  expect(received).toEqual([['/first', 218], ['/second', 218]]);
  expect(firstRequest.http.url).toBe('/first');
  expect(firstAnswer.http).toEqual({ status: 218 });
  firstHost.controller.abort();
  secondHost.controller.abort();
  first.discard(firstAnswer);
  second.discard(secondAnswer);
});
