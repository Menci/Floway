import { fireEvent, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import type { PropsWithChildren } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ModelListingFailure, UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamWorkspace } from '../../../src/components/upstream-editor/workspace';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

vi.mock('../../../src/components/upstream-editor/models-yaml-editor', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea aria-label="YAML models" onChange={event => onChange(event.target.value)} value={value} />
  ),
}));

vi.mock('../../../src/components/upstream-editor/feature-flags', () => ({
  FeatureFlagsEditor: () => null,
}));

vi.mock('../../../src/components/upstream-editor/model-detail', () => ({
  ModelDetail: () => null,
}));

vi.mock('../../../src/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ actionLabel, onConfirm, open }: { actionLabel: string; onConfirm: () => void; open: boolean }) =>
    open ? <button onClick={onConfirm} type="button">{actionLabel}</button> : null,
}));

vi.mock('../../../src/components/ui/scroll-area', () => ({
  ScrollArea: forwardRef<HTMLDivElement, PropsWithChildren>(({ children }, ref) => <div ref={ref}>{children}</div>),
}));

const model = (id: string) => ({
  upstreamModelId: id,
  publicModelId: id,
  display_name: id,
  kind: 'chat' as const,
  endpoints: { responses: {} },
});

const record = upstreamRecord('up_test', {
  name: 'Test',
  kind: 'custom',
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { responses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [model('model-a'), model('model-b')],
  },
  state: null,
});

function Harness({ modelsError = null }: { modelsError?: ModelListingFailure | null }) {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    // The workspace reads which tab and which model it is on out of the search,
    // so it needs a router to read one from.
    <MemoryRouter>
      <FormProvider {...form}>
        <UpstreamWorkspace
          discovered={[]}
          modelsLoading={false}
          modelsError={modelsError}
          onRefreshModels={vi.fn()}
          record={record}
        />
      </FormProvider>
    </MemoryRouter>
  );
}

// The subject here is the field array, not the wording. Resolving the queries
// through the resources keeps a copy edit from failing this suite as though the
// workspace had broken.
const models = (key: string) => i18n.t(`dashboard.upstreamEditor.models.${key}`);
const editCommand = (name: string) => i18n.t('dashboard.upstreamEditor.models.editNamed', { name });
// A row's delete command names the model it acts on, so the count queries match
// the command by its stem rather than by a whole label they would have to build
// a name for. A just-appended model has no name yet, and an accessible name is
// trimmed, so the stem is matched without its trailing separator.
const deleteCommandStem = i18n.t('dashboard.upstreamEditor.models.deleteNamed', { name: '\u0000' }).split('\u0000')[0]!.trimEnd();
const deleteCommands = () => screen.getAllByLabelText(new RegExp(`^${deleteCommandStem}`));

describe('upstream model workspace field-array transitions', () => {
  it('returns from a model detail to the model list', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: editCommand('model-a') }));
    await waitFor(() => expect(table.isConnected).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(await screen.findByRole('table', { name: models('title') })).toBeTruthy();
  });

  it('deletes a newly appended model without disturbing the existing rows', () => {
    renderInApp(<Harness />);
    expect(deleteCommands()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    expect(deleteCommands()).toHaveLength(3);
    fireEvent.click(deleteCommands()[2]!);
    fireEvent.click(screen.getByRole('button', { name: models('deleteConfirm') }));

    expect(deleteCommands()).toHaveLength(2);
    expect(screen.getByRole('button', { name: editCommand('model-a') })).toBeTruthy();
    expect(screen.getByRole('button', { name: editCommand('model-b') })).toBeTruthy();
  });

  it('replaces the manual rows with a shorter YAML catalog', async () => {
    renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: models('editAsYaml') }));
    const editor = await screen.findByLabelText('YAML models');
    fireEvent.change(editor, {
      target: {
        value: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    responses: {}\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: models('editWithUi') }));
    await waitFor(() => expect(deleteCommands()).toHaveLength(1));
    expect(screen.getByRole('button', { name: editCommand('replacement') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: editCommand('model-a') })).toBeNull();
    expect(screen.queryByRole('button', { name: editCommand('model-b') })).toBeNull();
  });
});

describe('upstream model listing failure wording', () => {
  it('writes the squashed upstream failure in its own words and quotes any other message', () => {
    const { unmount } = renderInApp(<Harness modelsError={{ message: 'Upstream model listing failed', upstreamListingFailed: true }} />);
    expect(screen.getByText(models('listingFailed'))).toBeTruthy();
    unmount();

    renderInApp(<Harness modelsError={{ message: 'Malformed custom upstream config', upstreamListingFailed: false }} />);
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: 'Malformed custom upstream config' }))).toBeTruthy();
  });
});
