import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineView } from '../../../src/components/requests/pipeline-view';
import type { LoadedDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import { renderInApp } from '../../render';
import { createDumpDecoder, projectWireExchanges, type EncodedDumpEvent } from '@floway-dev/dump/browser';

const run = { k: 'run', seq: 1, tMs: 0, runId: 'run', pipeline: 'serve', startedAt: 0 } as const;
const root = {
  k: 'enter', seq: 2, tMs: 10, stageId: 1, parentStageId: null, edge: 'root', name: 'client', pipeline: 'serve',
  facts: { model: 'before' },
} as const;

const events: EncodedDumpEvent[] = [
  run,
  root,
  {
    k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edge: 'next', name: 'upstream', pipeline: 'serve',
    facts: { model: 'after' },
  },
  { k: 'stream', seq: 4, tMs: 22, streamId: 7, stageId: 2, label: 'raw.bytes' },
  { k: 'stream', seq: 5, tMs: 23, streamId: 8, stageId: 2, wraps: 7, label: 'protocol.events' },
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
  { k: 'leave', seq: 10, tMs: 45, stageId: 2, facts: { status: 200, body: { $stream: 7 } } },
  { k: 'leave', seq: 11, tMs: 50, stageId: 1, baseChildId: 2, facts: { status: 200 } },
];

const artifact = (encoded = events): LoadedDumpArtifact => {
  const decoder = createDumpDecoder();
  const viewModel = decoder.pushEvents(encoded);
  return { meta: null, decoder, events: encoded, viewModel, wire: projectWireExchanges(viewModel) };
};

describe('pipeline perspective', () => {
  it('walks structural diffs, managed streams, and logs for the selected stage', () => {
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

  it('keeps elapsed time running after leave and nests a later turn under the answered parent', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(250);
      const liveEvents: EncodedDumpEvent[] = [
        run,
        { ...root, tMs: 0 },
        { k: 'leave', seq: 3, tMs: 100, stageId: 1, facts: {} },
        { k: 'enter', seq: 4, tMs: 150, stageId: 2, parentStageId: 1, edge: 'into', name: 'turn two', pipeline: 'serve', facts: {} },
      ];
      const view = (encoded: EncodedDumpEvent[]) => <PipelineView artifact={artifact(encoded)} isLiveStreaming selectedStageId={1} onSelectStage={vi.fn()} />;
      const { rerender } = renderInApp(view(liveEvents));
      const client = () => within(screen.getByRole('button', { name: /client/ }));
      expect(client().getByLabelText('Draining')).toBeTruthy();
      expect(client().queryByLabelText('Succeeded')).toBeNull();
      expect(client().getByText('250ms')).toBeTruthy();
      const turnTwo = screen.getByRole('button', { name: /turn two/ });
      expect(turnTwo.querySelector('span')?.style.paddingLeft).toBe('14px');
      await act(async () => { vi.advanceTimersByTime(250); });
      expect(client().getByText('500ms')).toBeTruthy();
      rerender(view([
        ...liveEvents,
        { k: 'closed', seq: 5, tMs: 510, stageId: 2, ok: true },
        { k: 'closed', seq: 6, tMs: 520, stageId: 1, ok: true },
      ]));
      expect(client().getByLabelText('Succeeded')).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(client().getByText('520ms')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows both execution and closure errors as failed stages', () => {
    const encoded: EncodedDumpEvent[] = [
      run, root,
      { k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edge: 'next', name: 'child', pipeline: 'serve', facts: {} },
      { k: 'fail', seq: 4, tMs: 24, stageId: 2, error: { message: 'execution failed' }, facts: {} },
      { k: 'leave', seq: 5, tMs: 30, stageId: 1, facts: {} },
      { k: 'closed', seq: 6, tMs: 45, stageId: 2, ok: false },
      { k: 'closed', seq: 7, tMs: 55, stageId: 1, ok: false, error: { message: 'closure failed' } },
      { k: 'done', seq: 8, tMs: 55, ok: false },
    ];
    const { rerender } = renderInApp(<PipelineView artifact={artifact(encoded.slice(0, 4))} selectedStageId={2} onSelectStage={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /child/ })).getByLabelText('Failed')).toBeTruthy();
    rerender(<PipelineView artifact={artifact(encoded)} selectedStageId={1} onSelectStage={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /client/ })).getByLabelText('Failed')).toBeTruthy();
  });
});
