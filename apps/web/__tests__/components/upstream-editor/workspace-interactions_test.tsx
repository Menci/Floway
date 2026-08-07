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
// A row's delete command names the model it acts on, so the count queries match
// the command by its stem rather than by a whole label they would have to build
// a name for. A just-appended model has no name yet, and an accessible name is
// trimmed, so the stem is matched without its trailing separator.
const deleteCommandStem = i18n.t('dashboard.upstreamEditor.models.deleteNamed', { name: '\u0000' }).split('\u0000')[0]!.trimEnd();
const deleteCommands = () => screen.getAllByLabelText(new RegExp(`^${deleteCommandStem}`));

describe('upstream model workspace field-array transitions', () => {
  it('opens a newly added model in the detail editor', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: models('add') }));

    await waitFor(() => expect(table.isConnected).toBe(false));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBe(null);
    expect(screen.queryByText('Model ID, kind, endpoints, and rerank target must form a valid model configuration.')).toBe(null);
  });

  it('keeps the same focused input while a new model ID changes', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    const input = screen.getByRole('textbox', { name: models('upstreamId') });
    input.focus();
    fireEvent.change(input, { target: { value: 'm' } });

    await waitFor(() => expect(screen.queryByRole('table', { name: models('title') })).toBe(null));
    expect(table.isConnected).toBe(false);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'model-new' } });
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('model-new');
    fireEvent.blur(input);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(input);
  });

  it('keeps temporarily duplicate IDs attached to separate rows while swapping them', async () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    const firstInput = screen.getByRole('textbox', { name: models('upstreamId') });
    fireEvent.change(firstInput, { target: { value: 'model-b' } });
    fireEvent.blur(firstInput);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(firstInput);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    await screen.findByRole('table', { name: models('title') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-b' }) }));
    const secondInput = screen.getByRole('textbox', { name: models('upstreamId') });
    expect(secondInput).not.toBe(firstInput);
    fireEvent.change(secondInput, { target: { value: 'model-a' } });
    fireEvent.blur(secondInput);
    expect(screen.getByRole('textbox', { name: models('upstreamId') })).toBe(secondInput);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    await screen.findByRole('table', { name: models('title') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('model-b');
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-b' }) }));
    expect((screen.getByRole('textbox', { name: models('upstreamId') }) as HTMLInputElement).value).toBe('model-a');
  });

  it('reports a missing model ID only after it prevents returning to the list', () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    expect(screen.queryByRole('alert')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    expect(screen.queryByRole('table', { name: models('title') })).toBe(null);
    expect(screen.getByText(models('upstreamIdRequired'))).toBeTruthy();
    const input = screen.getByRole('textbox', { name: models('upstreamId') });
    fireEvent.change(input, { target: { value: 'model-new' } });
    expect(screen.queryByText(models('upstreamIdRequired'))).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(screen.getByRole('table', { name: models('title') })).toBeTruthy();
  });

  it('reports a missing endpoint at its section after a blocked return', () => {
    renderInApp(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    fireEvent.change(screen.getByRole('textbox', { name: models('upstreamId') }), { target: { value: 'model-new' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '/chat/completions' }));
    expect(screen.queryByRole('alert')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: models('back') }));

    expect(screen.queryByRole('table', { name: models('title') })).toBe(null);
    expect(screen.getByText(models('endpointsRequired'))).toBeTruthy();
  });

  it('returns from a model detail to the model list', async () => {
    renderInApp(<Harness />);
    const table = screen.getByRole('table', { name: models('title') });

    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    await waitFor(() => expect(table.isConnected).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(await screen.findByRole('table', { name: models('title') })).toBeTruthy();
  });

  it('deletes a newly appended model and applies a shorter YAML catalog', async () => {
    renderInApp(<Harness />);
    expect(deleteCommands()).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: models('add') }));
    fireEvent.change(screen.getByRole('textbox', { name: models('upstreamId') }), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByRole('button', { name: models('back') }));
    expect(deleteCommands()).toHaveLength(3);
    fireEvent.click(deleteCommands()[2]!);
    fireEvent.click(await screen.findByRole('button', { name: models('deleteConfirm') }));
    await waitFor(() => expect(deleteCommands()).toHaveLength(2));

    // The confirmation dialog marks the rest of the document `aria-hidden`
    // while it is open and clears that on its way out, so the toolbar behind it
    // is unreachable by role until the exit settles. A label query does not
    // filter hidden nodes and hid the race; a role query has to wait for it.
    fireEvent.click(await screen.findByRole('button', { name: models('editAsYaml') }));
    const editor = await screen.findByLabelText('YAML models');
    fireEvent.change(editor, {
      target: {
        value: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    responses: {}\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: models('editWithUi') }));
    await waitFor(() => expect(deleteCommands()).toHaveLength(1));
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
