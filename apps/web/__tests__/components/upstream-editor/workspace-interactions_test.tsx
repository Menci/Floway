import { fireEvent, screen, waitFor } from '@testing-library/react';
import { forwardRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamWorkspace, type ModelsYamlDraft } from '../../../src/components/upstream-editor/workspace';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { UpstreamChatModelConfig, UpstreamModelConfig } from '@floway-dev/provider/browser';

vi.mock('../../../src/components/upstream-editor/models-yaml-editor', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea aria-label="YAML models" onChange={event => onChange(event.target.value)} value={value} />
  ),
}));

vi.mock('../../../src/components/ui/scroll-area', () => ({
  ScrollArea: forwardRef<HTMLDivElement, PropsWithChildren>(({ children }, ref) => <div ref={ref}>{children}</div>),
}));

const model = (id: string, chat?: UpstreamChatModelConfig) => ({
  upstreamModelId: id,
  publicModelId: id,
  display_name: id,
  kind: 'chat' as const,
  endpoints: { openaiResponses: {} },
  ...(chat ? { chat } : {}),
});

const record = upstreamRecord('up_test', {
  name: 'Test',
  kind: 'custom',
  config: {
    baseUrl: 'https://example.com',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [model('model-a'), model('model-b')],
  },
  state: null,
});
if (record.kind !== 'custom') throw new Error('test fixture must be a custom upstream');

function Harness({ discovered = [], source = record }: { discovered?: UpstreamModelConfig[]; source?: UpstreamRecord }) {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(source) });
  const [modelsYamlDraft, setModelsYamlDraft] = useState<ModelsYamlDraft | null>(null);
  return (
    // The workspace reads which tab and which model it is on out of the search,
    // so it needs a router to read one from.
    <MemoryRouter>
      <FormProvider {...form}>
        <UpstreamWorkspace
          editLevel="full"
          discovered={discovered}
          modelsYamlDraft={modelsYamlDraft}
          modelsLoading={false}
          modelsError={null}
          onModelsYamlDraftChange={setModelsYamlDraft}
          onRefreshModels={vi.fn()}
          record={source}
        />
      </FormProvider>
    </MemoryRouter>
  );
}

// The subject here is the field array, not the wording. Resolving the queries
// through the resources keeps a copy edit from failing this suite as though the
// workspace had broken.
const models = (key: string) => i18n.t(`dashboard.upstreamEditor.models.${key}`);

describe('upstream model workspace field-array transitions', () => {
  const detailLabel = models('imageDetailOriginal');

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

  it('reports a missing model ID only after it prevents returning to the list', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: models('editAsYaml') }));
    const yaml = (await screen.findByLabelText('YAML models') as HTMLTextAreaElement).value;
    expect(parse(yaml)).toContainEqual(expect.objectContaining({
      upstreamModelId: 'model-new',
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    }));
  });

  it('initializes, preserves, and clears original-detail support with image input', () => {
    const withChat = (chat: UpstreamChatModelConfig): UpstreamRecord => ({
      ...record,
      config: { ...record.config, models: [model('model-a', chat)] },
    });

    const first = renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(false);
    first.unmount();

    const second = renderInApp(<Harness source={withChat({ image_detail_original: true })} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    expect(screen.queryByRole('switch', { name: detailLabel })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(true);
    second.unmount();

    renderInApp(<Harness source={withChat({ modalities: { input: ['text', 'image'], output: ['text'] }, image_detail_original: true })} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.models.editNamed', { name: 'model-a' }) }));
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.queryByRole('switch', { name: detailLabel })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: models('imageInput') }));
    expect(screen.getByRole<HTMLInputElement>('switch', { name: detailLabel }).checked).toBe(false);
  });
});
