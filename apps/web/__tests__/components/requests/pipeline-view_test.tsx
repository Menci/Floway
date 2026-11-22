import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineView } from '../../../src/components/requests/pipeline-view';
import type { LoadedDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import { createDumpDecoder, type EncodedDumpEvent } from '@floway-dev/pipeline/browser';

const meta: DumpMetadata = {
  id: 'pipeline',
  method: 'POST',
  path: '/v1/chat/completions',
  startedAt: 0,
  completedAt: 500,
  status: 200,
  upstream: null,
  model: 'model',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 500,
  error: null,
};

const events: EncodedDumpEvent[] = [
  { k: 'run', seq: 1, tMs: 0, runId: 'run', pipelineName: 'serve', startedAt: 0 },
  {
    k: 'enter', seq: 2, tMs: 10, stageId: 1, parentStageId: null, edgeKind: 'root', name: 'client', tap: 'downstream',
    facts: { model: 'before' },
  },
  {
    k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edgeKind: 'child', name: 'upstream', tap: 'upstream',
    facts: { model: 'after' },
  },
  { k: 'stream', seq: 4, tMs: 22, streamId: 7, createdByStageId: 2, label: 'raw.bytes' },
  { k: 'stream', seq: 5, tMs: 23, streamId: 8, createdByStageId: 2, wraps: 7, label: 'protocol.events' },
  {
    k: 'frames',
    streamId: 8,
    frames: [
      { seq: 6, tMs: 25, v: { type: 'event', event: { delta: 'hello' } } },
      { seq: 7, tMs: 35, v: { type: 'done' } },
    ],
  },
  { k: 'end', seq: 8, tMs: 40, streamId: 8, how: 'exhausted' },
  { k: 'log', seq: 9, tMs: 41, stageId: 2, level: 'info', message: 'selected upstream', fields: { upstream: 'primary' } },
  { k: 'leave', seq: 10, tMs: 45, stageId: 2, outcome: { status: 200, body: { $stream: 7 } } },
  { k: 'leave', seq: 11, tMs: 50, stageId: 1, outcome: { status: 200 } },
];

const artifact = (): LoadedDumpArtifact => {
  const decoder = createDumpDecoder();
  const viewModel = decoder.pushEvents(events);
  return { meta, decoder, events, viewModel, wire: { downstreamRequest: null, upstreamAttempts: [], downstreamResponse: null } };
};

describe('pipeline perspective', () => {
  it('walks structural diffs, managed streams, and logs for the selected stage', async () => {
    const onSelectStage = vi.fn();
    const { rerender } = renderInApp(<PipelineView artifact={artifact()} selectedStageId={1} onSelectStage={onSelectStage} />);

    expect(screen.getByText('serve')).toBeTruthy();
    expect(screen.getByText('Stages (2)')).toBeTruthy();
    expect(screen.getByText('Downward facts → upstream')).toBeTruthy();
    expect(screen.getByText('model')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Streams' }));
    expect(screen.getByText('No managed streams are associated with this stage.')).toBeTruthy();

    const loaded = artifact();
    rerender(<PipelineView artifact={loaded} selectedStageId={2} onSelectStage={onSelectStage} />);
    expect(screen.getByRole('button', { name: /upstream/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Streams' }));
    expect(screen.getAllByText('#7 raw.bytes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('#8 protocol.events').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Logs' }));
    expect(screen.getByText('selected upstream')).toBeTruthy();
  });
});
