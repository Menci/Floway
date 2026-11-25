import { fireEvent, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import { decodeDump } from '@floway-dev/dump/browser';

test('opens a completed archive, showing stage handoffs and independent entity outcomes', async () => {
  const events = [
    {
      type: 'object', fromObjectId: 1, nodes: [
        { request: { $: 2 } },
        { model: 'original' },
        { request: { $: 4 } },
        { model: 'selected' },
        { message: 'candidate panic', cause: { $: 6 } },
        { message: 'nested cause' },
        {},
        { ok: true, value: 'body content' },
        { ok: false, error: 'bad frame' },
        { tokens: 10 },
        { body: { $stream: 1 }, usage: { $deferred: 1 } },
      ],
    },
    { type: 'stage.entered', stageId: 1, name: 'serve', facts: { $: 1 } },
    { type: 'stage.entered', stageId: 2, parentStageId: 1, name: 'terminal', facts: { $: 3 } },
    { type: 'stage.leaved', stageId: 2, error: { $: 5 } },
    { type: 'log', stageId: 2, '@timestamp': 1, '@localetime': '00:00', level: 'info', context: 'terminal', message: 'finished worker', fields: { $: 7 } },
    { type: 'stream.frame', streamId: 1, item: { $: 8 } },
    { type: 'stream.frame', streamId: 1, item: { $: 9 } },
    { type: 'stream.end', streamId: 1, error: 'stream panic' },
    { type: 'deferred.settled', deferredId: 1, value: { $: 10 } },
    { type: 'deferred.settled', deferredId: 2, error: 'deferred panic' },
    { type: 'stage.leaved', stageId: 1, facts: { $: 11 } },
  ];
  const archive = await decodeDump(new Response(events.map(event => JSON.stringify(event)).join('\n')).body!);
  renderInApp(<RequestDetailPanel archive={archive} recordId="request-1" error={null} retainLastRecord={false} />);

  const navigation = within(await screen.findByRole('navigation', { name: 'Pipeline archive navigation' }));
  expect(screen.getByText('Returned facts')).toBeTruthy();
  fireEvent.click(navigation.getByRole('button', { name: 'terminal #2' }));
  expect(screen.getByText('Request handoff')).toBeTruthy();
  expect(screen.getByText('["request"]["model"]')).toBeTruthy();
  expect(screen.getByText('"original"')).toBeTruthy();
  expect(screen.getByText('"selected"')).toBeTruthy();
  expect(screen.getByText('"candidate panic"')).toBeTruthy();
  expect(screen.getByText('finished worker')).toBeTruthy();

  fireEvent.click(navigation.getByRole('button', { name: 'serve #1' }));
  const outcome = within(screen.getByRole('heading', { name: 'Outcome' }).closest('section')!);
  fireEvent.click(outcome.getByRole('button', { name: 'Stream #1' }));
  expect(screen.getByText('"stream panic"')).toBeTruthy();
  expect(screen.getByText('"body content"')).toBeTruthy();
  expect(screen.getByText('"bad frame"')).toBeTruthy();
  fireEvent.click(navigation.getByRole('button', { name: 'Deferred #1' }));
  expect(screen.getByText('Resolved value')).toBeTruthy();
  expect(screen.getByText('tokens')).toBeTruthy();
  fireEvent.click(navigation.getByRole('button', { name: 'Deferred #2' }));
  expect(screen.getByText('"deferred panic"')).toBeTruthy();
});
