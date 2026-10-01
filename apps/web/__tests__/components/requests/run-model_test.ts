import { describe, expect, it } from 'vitest';

import { readRun } from '../../../src/components/requests/run-model';

describe('run stage model', () => {
  it('restores inherited entries, repeated descents and folded returns', () => {
    const model = readRun([
      { type: 'object', fromObjectId: 1, nodes: [{ text: 'before' }, { text: 'after' }] },
      { type: 'stage.entered', stageId: 1, name: 'fork', parentStageId: null, facts: { request: { $: 1 } } },
      { type: 'stage.entered', stageId: 2, name: 'first', parentStageId: 1 },
      { type: 'stage.leaved', stageId: 2, facts: { response: 'retry' } },
      { type: 'stage.entered', stageId: 3, name: 'second', parentStageId: 1, facts: { request: { $: 2 } } },
      { type: 'stage.leaved', stageId: 3, facts: { response: 'answer' } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const fork = model.roots[0]!;
    expect(fork.children.map(stage => stage.id)).toEqual([2, 3]);
    expect(fork.children[0]!.request).toBe(fork.request);
    expect(model.state(fork.response!)).toEqual({ response: 'answer' });
    expect(model.diff(fork.request, fork.children[1]!.request)).toEqual([
      { path: ['request', 'text'], kind: 'changed', before: 'before', after: 'after' },
    ]);
  });

  it('does not fold a successful child response into a parent that subsequently failed', () => {
    const model = readRun([
      { type: 'object', fromObjectId: 1, nodes: [{ $error: { name: 'Error', message: 'projection failed', stack: 'stack' } }] },
      { type: 'stage.entered', stageId: 1, name: 'projection', parentStageId: null, facts: {} },
      { type: 'stage.entered', stageId: 2, name: 'answer', parentStageId: 1 },
      { type: 'stage.leaved', stageId: 2, facts: { answer: 'upstream value' } },
      { type: 'stage.failed', stageId: 1, error: { $: 1 } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const parent = model.roots[0]!;
    expect(parent.response).toBeNull();
    expect(parent.children[0]!.response).toEqual({ answer: 'upstream value' });
    expect(model.state(parent.failure!)).toMatchObject({ error: { $error: { message: 'projection failed' } } });
  });

  it('uses shared object identities, handles cycles and decodes schema keys', () => {
    const model = readRun([
      { type: 'object', fromObjectId: 1, nodes: [{ '$$ref': 'schema', self: { $: 1 } }, { '$$ref': 'next', self: { $: 2 } }] },
      { type: 'stage.entered', stageId: 1, name: 'stage', parentStageId: null, facts: { same: { $: 1 }, changed: { $: 1 } } },
      { type: 'stage.leaved', stageId: 1, facts: { same: { $: 1 }, changed: { $: 2 }, added: { $undefined: true } } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const stage = model.roots[0]!;
    expect(model.state(stage.request)).toEqual({
      same: { $ref: 'schema', self: { $cycle: 1 } }, changed: { $ref: 'schema', self: { $cycle: 1 } },
    });
    expect(model.diff(stage.request, stage.response!)).toEqual([
      { path: ['changed', '$ref'], kind: 'changed', before: 'schema', after: 'next' },
      { path: ['added'], kind: 'added', after: { $undefined: true } },
    ]);
  });
  it('reports both changed aliases and displays a late deferred outcome', () => {
    const model = readRun([
      { type: 'object', fromObjectId: 1, nodes: [{ value: 'old' }, { value: 'new' }, { $deferred: true }, { status: 'fulfilled', value: { usage: 5 } }] },
      { type: 'stage.entered', stageId: 1, name: 'stage', parentStageId: null, facts: { first: { $: 1 }, second: { $: 1 } } },
      { type: 'stage.leaved', stageId: 1, facts: { first: { $: 2 }, second: { $: 2 }, pending: { $: 3 } } },
      { type: 'deferred.settled', deferred: { $: 3 }, outcome: { $: 4 } },
    ].map(event => JSON.stringify(event)).join('\n'));
    const stage = model.roots[0]!;
    expect(model.diff(stage.request, stage.response!).slice(0, 2)).toEqual([
      { path: ['first', 'value'], kind: 'changed', before: 'old', after: 'new' },
      { path: ['second', 'value'], kind: 'changed', before: 'old', after: 'new' },
    ]);
    expect(model.state(stage.response!)).toMatchObject({ pending: { $deferred: { status: 'fulfilled', value: { usage: 5 } } } });
  });

  it('resolves referenced protocol streams through aliases and cycles without treating schema keys as stream tags', () => {
    const model = readRun([
      {
        type: 'object', fromObjectId: 1, nodes: [
          { stream: { $stream: 2 }, '$$stream': 999, self: { $: 1 } },
          { type: 'event', event: { type: 'citation', source: 'https://example.test', '$$schema': 'value' } },
        ],
      },
      { type: 'stage.entered', stageId: 1, name: 'translate', parentStageId: null, facts: { source: { $: 1 } } },
      { type: 'stage.leaved', stageId: 1, facts: { source: { $: 1 }, client: { $stream: 3 } } },
      { type: 'stream.frame', streamId: 2, frames: [{ $: 2 }] },
      { type: 'stream.end', streamId: 2 },
    ].map(event => JSON.stringify(event)).join('\n'));
    const stage = model.roots[0]!;
    const streams = model.referencedStreams(stage.request, stage.response!);
    expect(streams.map(stream => ({ id: stream.id, ended: stream.ended }))).toEqual([{ id: 2, ended: true }, { id: 3, ended: false }]);
    expect(model.frameValue(streams[0]!.frames[0]!)).toEqual({ type: 'event', event: { type: 'citation', source: 'https://example.test', $schema: 'value' } });
    expect(streams[1]!.frames).toEqual([]);
  });

});
