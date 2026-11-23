import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import type { LoadedDumpArtifact } from '../../../src/components/requests/use-dump-artifact';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { createDumpDecoder, projectWireExchanges, type EncodedDumpEvent, type StoredValue } from '@floway-dev/dump/browser';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

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

const request = (origin: string, pathname: string, model: string) => ({
  method: 'POST', url: { origin, pathname }, headers: [], body: { $bytes: btoa(JSON.stringify({ model })) },
});
const response = (
  status: number,
  body: StoredValue,
  { contentType = 'application/json', ...details }: { contentType?: string; exchange?: 'upstream'; transportError?: StoredValue } = {},
) => ({
  'response.http': { status, statusText: '', headers: [['content-type', contentType]], body, timing: { startedAt: 1, headersAt: 5 }, ...details },
});
const run = { k: 'run', seq: 1, tMs: 0, runId: 'run', pipeline: 'serve', startedAt: 0 } as const;
const root = {
  k: 'enter', seq: 2, tMs: 10, stageId: 1, parentStageId: null, edge: 'root', name: 'client', pipeline: 'serve',
  facts: { 'request.http': request('https://gateway.test', '/v1/chat/completions', 'client-model') },
} as const;
const events: EncodedDumpEvent[] = [
  run,
  root,
  {
    k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edge: 'next', name: 'primary upstream', pipeline: 'serve',
    facts: { 'request.http': request('https://upstream.test', '/v1/chat/completions', 'upstream-model') },
  },
  { k: 'leave', seq: 4, tMs: 30, stageId: 2, facts: response(503, null, { exchange: 'upstream' }) },
  { k: 'closed', seq: 5, tMs: 35, stageId: 2, ok: true },
  {
    k: 'enter', seq: 6, tMs: 40, stageId: 3, parentStageId: 1, edge: 'subrun', name: 'fallback upstream', pipeline: 'fallback',
    facts: { 'request.http': request('https://other.test', '/v1/messages', 'fallback-model') },
  },
  { k: 'leave', seq: 7, tMs: 55, stageId: 3, facts: response(200, { $bytes: btoa('{"upstream":true}') }, { exchange: 'upstream' }) },
  { k: 'closed', seq: 8, tMs: 57, stageId: 3, ok: true },
  { k: 'leave', seq: 9, tMs: 60, stageId: 1, baseChildId: 3, facts: response(200, { $bytes: btoa('{"client":true}') }) },
  { k: 'closed', seq: 10, tMs: 400, stageId: 1, ok: true },
  { k: 'done', seq: 11, tMs: 500, ok: true },
];

const artifact = (encoded = events, metadata = meta): LoadedDumpArtifact => {
  const decoder = createDumpDecoder();
  const viewModel = decoder.pushEvents(encoded);
  return { meta: metadata, decoder, events: encoded, viewModel, wire: projectWireExchanges(viewModel) };
};

describe('request detail', () => {
  it('opens wire and pipeline perspectives and jumps from an upstream request to its stage', async () => {
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={artifact()} />);

    expect(await screen.findByRole('radio', { name: 'Wire' })).toBeTruthy();
    expect((await screen.findByTestId('body-content')).textContent).toContain('"client": true');
    fireEvent.click(await screen.findByRole('combobox', { name: 'Request details' }));
    fireEvent.click(screen.getByRole('option', { name: 'Upstream request' }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('fallback-model');
    fireEvent.click(screen.getByRole('combobox', { name: 'Upstream calls' }));
    fireEvent.click(screen.getByRole('option', { name: /POST \/v1\/chat\/completions 503/ }));
    expect((await screen.findByTestId('body-content')).textContent).toContain('upstream-model');
    fireEvent.click(screen.getByRole('button', { name: 'Inspect stage' }));
    expect(screen.getByRole('radio', { name: 'Pipeline' }).closest('label')?.hasAttribute('data-checked')).toBe(true);
    expect(screen.getByRole('button', { name: /primary upstream/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps malformed raw response bytes available and reports capture warnings', async () => {
    const loaded = artifact([
      run, root,
      { k: 'stream', seq: 3, tMs: 52, streamId: 12, stageId: 1, label: 'client.bytes' },
      { k: 'leave', seq: 4, tMs: 53, stageId: 1, facts: response(200, { $stream: 12 }, { contentType: 'text/event-stream' }) },
      { k: 'frames', streamId: 12, frames: [{ seq: 5, tMs: 54, v: { $bytes: btoa('data: {broken\n') } }] },
      { k: 'truncated', seq: 6, tMs: 54, reason: 'size-limit' },
      { k: 'done', seq: 7, tMs: 500, ok: true },
    ]);
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={loaded} />);

    expect((await screen.findByText('data: {broken', { exact: false })).textContent).toContain('data: {broken');
    expect(screen.getByText(i18n.t('requests.partialCapture'))).toBeTruthy();
    expect(screen.getByText(i18n.t('requests.traceSizeLimit'))).toBeTruthy();
  });

  it.each([undefined, 0, 3])('explains queue truncation with droppedEvents set to %s', droppedEvents => {
    const metadata = { ...meta, truncated: true, ...(droppedEvents === undefined ? {} : { droppedEvents }) };
    const loaded = artifact([
      run, root,
      { k: 'truncated', seq: 3, tMs: 54, reason: 'queue-limit' },
      { k: 'done', seq: 4, tMs: 500, ok: true },
    ], metadata);
    renderInApp(<RequestDetailPanel recordId="detail" meta={metadata} error={null} retainLastRecord={false} preloaded={loaded} />);

    expect(screen.getByText(droppedEvents
      ? i18n.t('requests.truncatedTrace', { dropped: droppedEvents })
      : i18n.t('requests.traceQueueLimit'))).toBeTruthy();
  });

  it('reports a failed request body upload', async () => {
    const loaded = artifact([
      run,
      {
        ...root,
        facts: {
          'request.http': {
            ...root.facts['request.http'],
            body: { kind: 'upload-error', error: { name: 'Error', message: 'Upload interrupted' } },
          },
        },
      },
    ]);
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={loaded} />);

    expect(await screen.findByText(i18n.t('requests.uploadFailed'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('requests.emptyBody'))).toBeNull();
  });

  it('reports a transport failure recorded on an upstream response', async () => {
    const loaded = artifact([
      run, root,
      {
        k: 'enter', seq: 3, tMs: 20, stageId: 2, parentStageId: 1, edge: 'next', name: 'upstream', pipeline: 'serve',
        facts: { 'request.http': request('https://upstream.test', '/v1/chat/completions', 'upstream-model') },
      },
      {
        k: 'leave', seq: 4, tMs: 30, stageId: 2,
        facts: response(502, null, { exchange: 'upstream', transportError: { name: 'Error', message: 'Connection failed' } }),
      },
    ]);
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={loaded} />);
    fireEvent.click(await screen.findByRole('combobox', { name: i18n.t('requests.detailTitle') }));
    fireEvent.click(screen.getByRole('option', { name: i18n.t('requests.upstreamResponse') }));

    expect(await screen.findByText(i18n.t('requests.transportFailed'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('requests.emptyBody'))).toBeNull();
  });

  it('keeps captured response bytes visible after a transport failure in the stream', async () => {
    const loaded = artifact([
      run, root,
      { k: 'stream', seq: 3, tMs: 52, streamId: 12, stageId: 1, label: 'client.bytes' },
      { k: 'leave', seq: 4, tMs: 53, stageId: 1, facts: response(200, { $stream: 12 }, { contentType: 'text/event-stream' }) },
      {
        k: 'frames', streamId: 12, frames: [
          { seq: 5, tMs: 54, v: { $bytes: btoa('data: {"partial"') } },
          { seq: 6, tMs: 55, v: { type: 'transport-error', error: { name: 'Error', message: 'Connection interrupted' } } },
        ],
      },
      { k: 'end', seq: 7, tMs: 56, streamId: 12, how: 'exhausted' },
    ]);
    renderInApp(<RequestDetailPanel recordId="detail" meta={meta} error={null} retainLastRecord={false} preloaded={loaded} />);

    expect(await screen.findByText(i18n.t('requests.transportFailed'))).toBeTruthy();
    expect(screen.getByText('data: {"partial"')).toBeTruthy();
  });
});
