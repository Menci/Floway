import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { extractRawWireBytes } from '../../../src/components/requests/stream-render';
import type { LoadedDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import { createDumpDecoder, projectWireView, type EncodedDumpEvent } from '@floway-dev/pipeline/browser';

vi.mock('../../../src/components/ui/body-editor', () => ({
  default: ({ text, toolbarStart, emptyText }: { text: string; toolbarStart?: ReactNode; emptyText?: string }) =>
    <>{toolbarStart}<pre data-testid="body-content">{text !== '' ? text : emptyText ?? ''}</pre></>,
}));

const meta: DumpMetadata = {
  id: 'detail',
  method: 'POST',
  path: '/v1/chat/completions',
  startedAt: 0,
  completedAt: 500,
  status: 200,
  upstream: null,
  model: 'model',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 10,
  responseBytes: 20,
  durationMs: 500,
  error: null,
};

const events: EncodedDumpEvent[] = [
  { k: 'run', seq: 1, tMs: 0, runId: 'run', pipelineName: 'serve', startedAt: 0 },
  {
    k: 'enter', seq: 2, tMs: 10, stageId: 1, parentStageId: null, edgeKind: 'root', name: 'client', tap: 'downstream',
    facts: {
      'request.http': {
        method: 'POST', url: 'https://gateway.test/v1/chat/completions', headers: [['authorization', 'client-secret-token-123456']],
        body: { model: 'client-model' },
      },
      model: 'client-model',
    },
  },
  {
    k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edgeKind: 'child', name: 'upstream', tap: 'upstream',
    facts: {
      'request.http': {
        method: 'POST', url: 'https://upstream.test/v1/chat/completions?api_key=secret', headers: [['authorization', { $secret: { length: 20, hash: 'abcdef1234567890', redacted: '********' } }]],
        body: { model: 'upstream-model' },
      },
      'route.candidate': { upstreamId: 'primary', modelId: 'public-model' },
    },
  },
  { k: 'stream', seq: 4, tMs: 25, streamId: 10, createdByStageId: 2, label: 'raw.bytes' },
  { k: 'stream', seq: 5, tMs: 26, streamId: 11, createdByStageId: 2, wraps: 10, label: 'protocol.events' },
  {
    k: 'frames',
    streamId: 11,
    frames: [
      { seq: 6, tMs: 30, v: { type: 'event', event: { id: 'chunk', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] } } },
      { seq: 7, tMs: 40, v: { type: 'done' } },
    ],
  },
  { k: 'end', seq: 8, tMs: 45, streamId: 11, how: 'exhausted' },
  { k: 'leave', seq: 9, tMs: 50, stageId: 2, outcome: { status: 200, headers: [['content-type', 'text/event-stream']], body: { $stream: 10 } } },
  {
    k: 'enter', seq: 10, tMs: 51, stageId: 3, parentStageId: 1, edgeKind: 'child', name: 'response', tap: 'downstream',
    facts: { 'request.http': { method: 'POST', url: 'https://gateway.test/v1/chat/completions', headers: [], body: { model: 'client-model' } } },
  },
  { k: 'stream', seq: 11, tMs: 52, streamId: 12, createdByStageId: 3, label: 'client.bytes' },
  { k: 'frames', streamId: 12, frames: [{ seq: 12, tMs: 53, v: { $bytes: btoa('data: client\n') } }] },
  { k: 'end', seq: 13, tMs: 54, streamId: 12, how: 'exhausted' },
  { k: 'leave', seq: 14, tMs: 55, stageId: 3, outcome: { status: 200, headers: [['content-type', 'text/event-stream']], body: { $stream: 12 } } },
  { k: 'leave', seq: 15, tMs: 60, stageId: 1, outcome: { status: 200, headers: [['content-type', 'application/json']], body: { ok: true } } },
  { k: 'done', seq: 16, tMs: 500, ok: true },
];

const artifact = (): LoadedDumpArtifact => {
  const decoder = createDumpDecoder();
  const viewModel = decoder.pushEvents(events);
  return { meta, decoder, events, viewModel, wire: projectWireView(viewModel) };
};

describe('request detail', () => {
  it('opens wire and pipeline perspectives and jumps from an upstream request to its stage', async () => {
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={artifact()} />);

    expect(await screen.findByRole('radio', { name: 'Wire' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Inspection view' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Upstream request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('upstream-model');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect stage' }));
    expect(screen.getByRole('radio', { name: 'Pipeline' }).closest('label')?.hasAttribute('data-checked')).toBe(true);
    expect(screen.getByRole('button', { name: /upstream/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps malformed raw response bytes available and reports capture warnings', async () => {
    const malformed: EncodedDumpEvent[] = events.map(event => {
      if (event.k === 'leave' && event.stageId === 3) {
        return { ...event, outcome: { status: 200, headers: [['content-type', 'text/event-stream']], body: { $stream: 12 } } };
      }
      if (event.k === 'end' && event.streamId === 12) return null;
      if (event.k !== 'frames' || event.streamId !== 12) return event;
      return {
        ...event,
        frames: [{ seq: 12, tMs: 53, v: { $bytes: btoa('data: {broken\n') } }],
      };
    }).filter((event): event is EncodedDumpEvent => event !== null);
    const decoder = createDumpDecoder();
    const viewModel = decoder.pushEvents(malformed);
    const response = projectWireView(viewModel).downstreamResponse;
    expect(response?.rawFrames).toHaveLength(1);
    expect(extractRawWireBytes(response)).toBeInstanceOf(Uint8Array);
    const loaded = { meta, decoder, events: malformed, viewModel, wire: projectWireView(viewModel) };
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={loaded} />);

    fireEvent.click(await screen.findByRole('combobox', { name: 'Response body view' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Raw bytes' }));
    expect((await screen.findByText('data: {broken', { exact: false })).textContent).toContain('data: {broken');
    expect(screen.getByText(i18n.t('requests.partialCapture'))).toBeTruthy();
  });
});
