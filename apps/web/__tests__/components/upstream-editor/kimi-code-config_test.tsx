import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ModelDetail } from '../../../src/components/upstream-editor/model-detail';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';
import { currentUsage, kimiCodeRecord } from '../upstreams/kimi-code-fixture';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { 'kimi-code': { usage: { $post: mocks.refresh } } } } },
  callApi: (operation: () => unknown) => operation(),
}));

beforeEach(() => { primeDefaultSession(); mocks.refresh.mockReset(); });

const Harness = ({ readOnly = false }: { readOnly?: boolean }) => {
  const record = kimiCodeRecord();
  if (readOnly) record.config = { region: 'china', apiKeySet: true };
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return <FormProvider {...form}><ProviderConfigSection readOnly={readOnly} record={record} onPatch={() => {}} onRefreshModels={() => {}} /></FormProvider>;
};

test('quota refresh uses the edited region and API key', async () => {
  mocks.refresh.mockResolvedValue({ data: { observation: { fetchedAt: 2000, data: currentUsage }, account: null, accountError: null }, error: null });
  renderInApp(<Harness />);
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('dashboard.upstreamEditor.kimiCode.regions.overseas') }));
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.upstreamEditor.fields.apiKey')), { target: { value: 'sk-kimi-fake-replacement' } });
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.kimiCode.usage.load') }));
  expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ json: { record: expect.objectContaining({ config: { region: 'overseas', apiKey: 'sk-kimi-fake-replacement' } }) } }), expect.anything());
});

test('catalog-owned Kimi Code model pricing stays read-only for editable connections', () => {
  const onChange = vi.fn();
  renderInApp(<ModelDetail
    onChange={onChange} onDelete={() => {}} onSourceChange={() => {}} onUpstreamModelIdCommit={() => {}}
    readOnly={false} record={kimiCodeRecord()} revealValidation={false} section="details" upstreamFlags={{}}
    row={{ key: 'auto:k3.1-pro', source: 'auto', manualIndex: null, hasAuto: true, config: { upstreamModelId: 'k3.1-pro', publicModelId: 'kimi-k3.1-pro', display_name: 'K3.1 Pro', kind: 'chat', endpoints: { openaiChatCompletions: {} }, pricing: { entries: [{ rates: { input_tokens: '0.000002' } }] } } }}
  />);
  expect(screen.getByRole('heading', { name: i18n.t('dashboard.upstreamEditor.models.pricing') })).toBeTruthy();
  expect(screen.getByDisplayValue<HTMLInputElement>('2').readOnly).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
