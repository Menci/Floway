import { screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const DirtyProbe = ({ record }: { record: UpstreamRecord }) => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <output data-testid="dirty">{String(form.formState.isDirty)}</output>
      <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    </FormProvider>
  );
};

const custom = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { chatCompletions: {} },
    modelsFetch: { enabled: true },
    models: [],
  },
  state: null,
});

describe('probe', () => {
  it('reports dirtiness of an untouched custom config', () => {
    renderInApp(<DirtyProbe record={custom} />);
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });
});
