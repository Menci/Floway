import { fireEvent, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { PipelineViewer } from '../../../src/components/requests/pipeline-viewer';
import { renderInApp } from '../../render';
import { decodeDump } from '@floway-dev/dump/browser';

const dump = decodeDump([
  { type: 'object', fromObjectId: 1, nodes: [{ payload: { $: 2 }, stream: { $stream: 1 }, deferred: { $deferred: 1 } }, { nested: 'original' }, { payload: { $: 4 } }, { nested: 'revised' }] },
  { type: 'stage.entered', stageId: 1, name: 'serve.request', facts: { $: 1 } },
  { type: 'stage.entered', stageId: 2, parentStageId: 1, name: 'provider.call', facts: { $: 3 } },
  { type: 'object', fromObjectId: 5, nodes: [{ message: 'upstream failed' }, { offset: 12 }, { upstream: 'primary' }] },
  { type: 'log', stageId: 2, '@timestamp': 123, '@localetime': '123', level: 'warn', context: 'provider.call', fields: { $: 7 }, message: 'upstream returned an error' },
  { type: 'stream.frame', streamId: 1, item: { ok: true, value: 'first frame' } },
  { type: 'stream.frame', streamId: 1, item: { ok: false, error: 'failed frame' } },
  { type: 'stream.end', streamId: 1 },
  { type: 'deferred.settled', deferredId: 1, ok: true, value: 'settled value' },
  { type: 'stage.panicked', stageId: 2, error: { $: 5 }, facts: { $: 6 } },
  { type: 'stage.panicked', stageId: 1, error: { $: 5 } },
].map(event => `${JSON.stringify(event)}\n`).join(''));

test('selects a nested stage and shows the original panic details and stage logs', () => {
  const view = renderInApp(<PipelineViewer dump={dump} onDownload={() => {}} />);
  expect(view.queryByText('Facts at the throw site')).toBeNull();
  const tree = within(view.getByRole('tree', { name: 'Stages' }));
  fireEvent.click(tree.getByText('provider.call'));
  expect(view.getByRole('heading', { name: 'provider.call' })).not.toBeNull();
  const changes = view.getByText('Changes from the parent request').closest('details')!;
  changes.open = true;
  fireEvent(changes, new Event('toggle'));
  expect(view.getByText('["payload"]["nested"]')).not.toBeNull();
  expect(view.getByText('Facts at the throw site')).not.toBeNull();
  expect(view.getByText('offset')).not.toBeNull();
  expect(view.getByText('warn upstream returned an error')).not.toBeNull();
});

test('opens stream and deferred references and exports the selected archive', () => {
  const download = vi.fn();
  const view = renderInApp(<PipelineViewer dump={dump} onDownload={download} />);
  fireEvent.click(view.getByRole('button', { name: 'Stream 1' }));
  expect(view.getByText('"first frame"')).not.toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Next frame' }));
  expect(view.getByText('"failed frame"')).not.toBeNull();
  expect(view.getByText('Stream ended')).not.toBeNull();
  fireEvent.click(view.getByRole('tab', { name: 'Stages' }));
  fireEvent.click(view.getByRole('button', { name: 'Deferred 1' }));
  expect(view.getByText('"settled value"')).not.toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Export record' }));
  expect(download).toHaveBeenCalledOnce();
});
