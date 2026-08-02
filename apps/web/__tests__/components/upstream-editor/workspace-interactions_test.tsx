import { fireEvent, screen, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import type { PropsWithChildren } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/editor-data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/editor-data';
import { UpstreamWorkspace } from '../../../src/components/upstream-editor/workspace';
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

const record = {
  id: 'up_test',
  name: 'Test',
  kind: 'custom',
  enabled: true,
  sort_order: 1,
  created_at: '',
  updated_at: '',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  color: null,
  modelsCache: { fetchedAt: null, lastError: null },
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { responses: {} },
    modelsFetch: { enabled: false },
    models: [model('model-a'), model('model-b')],
  },
  state: null,
} as unknown as UpstreamRecord;

function Harness() {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    // The workspace reads which tab and which model it is on out of the search,
    // so it needs a router to read one from.
    <MemoryRouter>
      <FormProvider {...form}>
        <UpstreamWorkspace
          discovered={[]}
          modelsLoading={false}
          modelsError={null}
          onRefreshModels={vi.fn()}
          record={record}
        />
      </FormProvider>
    </MemoryRouter>
  );
}

describe('upstream model workspace field-array transitions', () => {
  it('deletes a newly appended model and applies a shorter YAML catalog', async () => {
    renderInApp(<Harness />);
    expect(screen.getAllByLabelText('Delete manual model')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getAllByLabelText('Delete manual model')).toHaveLength(3);
    fireEvent.click(screen.getAllByLabelText('Delete manual model')[2]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
    await waitFor(() => expect(screen.getAllByLabelText('Delete manual model')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Edit as YAML' }));
    const editor = await screen.findByLabelText('YAML models');
    fireEvent.change(editor, {
      target: {
        value: '- upstreamModelId: replacement\n  publicModelId: replacement\n  kind: chat\n  endpoints:\n    responses: {}\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit with UI' }));
    await waitFor(() => expect(screen.getAllByLabelText('Delete manual model')).toHaveLength(1));
  });
});
