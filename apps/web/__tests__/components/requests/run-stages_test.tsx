import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunStages } from '../../../src/components/requests/run-stages';
import { renderInApp } from '../../render';

vi.mock('../../../src/components/ui/body-editor', () => ({
  default: ({ text, toolbarStart }: { text: string; toolbarStart: React.ReactNode }) => <div>{toolbarStart}<pre data-testid="state">{text}</pre></div>,
}));

const ndjson = [
  { type: 'object', fromObjectId: 1, nodes: [{ text: 'before' }, { text: 'after' }] },
  { type: 'stage.entered', stageId: 1, name: 'source', parentStageId: null, facts: { request: { $: 1 } } },
  { type: 'stage.entered', stageId: 2, name: 'target', parentStageId: 1, facts: { request: { $: 2 } } },
  { type: 'stage.leaved', stageId: 2, facts: { response: 'answer' } },
].map(event => JSON.stringify(event)).join('\n');

describe('run stages', () => {
  it('selects a stage and restores its actual request values', async () => {
    renderInApp(<RunStages ndjson={ndjson} />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('before'));
    fireEvent.click(screen.getByRole('treeitem', { name: 'target #2' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('after'));
  });

  it('compares the values on a descent and the folded response', async () => {
    renderInApp(<RunStages ndjson={ndjson} />);
    await screen.findByTestId('state');
    fireEvent.click(screen.getByRole('combobox', { name: 'Stage view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Request changes' }));
    expect(screen.getByTestId('state').textContent).toContain('"before": "before"');
    expect(screen.getByTestId('state').textContent).toContain('"after": "after"');
    fireEvent.click(screen.getByRole('combobox', { name: 'Stage view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Response facts' }));
    expect(screen.getByTestId('state').textContent).toContain('"response": "answer"');
  });

  it('shows the failure separately from a child response', async () => {
    renderInApp(<RunStages ndjson={`${ndjson}\n${JSON.stringify({ type: 'stage.failed', stageId: 1, error: 'projection failed' })}`} />);
    await screen.findByTestId('state');
    fireEvent.click(screen.getByRole('combobox', { name: 'Stage view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Response facts' }));
    expect(screen.getByText('This stage failed without returning facts.')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Stage view' }));
    fireEvent.click(screen.getByRole('option', { name: 'Stage error' }));
    expect(screen.getByTestId('state').textContent).toContain('projection failed');
  });

});
