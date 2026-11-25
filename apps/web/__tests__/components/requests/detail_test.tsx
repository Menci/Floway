import { expect, test } from 'vitest';

import { RequestDetailPanel } from '../../../src/components/requests/detail';
import { renderInApp } from '../../render';
import { decodeDump } from '@floway-dev/dump/browser';

const contents = '{"type":"object","fromObjectId":1,"nodes":[{}]}\n{"type":"stage.entered","stageId":1,"name":"root-stage","facts":{"$":1}}\n{"type":"stage.leaved","stageId":1,"facts":{"$":1}}\n';
const record = { id: 'one', contents, dump: decodeDump(contents) };

test('retains the archive viewer while the request drawer closes', () => {
  const view = renderInApp(<RequestDetailPanel record={record} recordId="one" error={null} retainLastRecord />);
  view.rerender(<RequestDetailPanel record={null} recordId={null} error={null} retainLastRecord />);
  expect(view.getByRole('heading', { name: 'root-stage' })).not.toBeNull();
  view.rerender(<RequestDetailPanel record={null} recordId={null} error={null} retainLastRecord={false} />);
  expect(view.queryByRole('heading', { name: 'root-stage' })).toBeNull();
  expect(view.getByText('Select a request to inspect its details')).not.toBeNull();
});
