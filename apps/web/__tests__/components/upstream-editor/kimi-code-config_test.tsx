import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { beforeEach, expect, test, vi } from 'vitest';

import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
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

const Harness = ({ readOnly = false, sidebar = false }: { readOnly?: boolean; sidebar?: boolean }) => {
  const record = kimiCodeRecord();
  if (readOnly) record.config = { region: 'china', apiKeySet: true };
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return <FormProvider {...form}>{sidebar
    ? <UpstreamConfigSidebar catalogAvailable discovered={[]} editLevel={readOnly ? 'off' : 'full'} onPatch={() => {}} onRefreshModels={() => {}} proxies={[]} record={record} runtime={{ kind: 'node', runtimeLocation: 'TEST' }} />
    : <ProviderConfigSection readOnly={readOnly} record={record} onPatch={() => {}} onRefreshModels={() => {}} />}</FormProvider>;
};

test('Kimi Code exposes the background usage interval in the connection sidebar', () => {
  renderInApp(<Harness sidebar />);
  expect(screen.getByRole('heading', { name: i18n.t('dashboard.upstreamEditor.usageRefresh.title') })).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: i18n.t('dashboard.upstreamEditor.usageRefresh.interval') }).disabled).toBe(false);
});

test('quota refresh uses the edited region and API key', async () => {
  mocks.refresh.mockResolvedValue({ data: { observation: { fetchedAt: 2000, data: currentUsage }, account: null, accountError: null }, error: null });
  renderInApp(<Harness />);
  fireEvent.click(screen.getByRole('radio', { name: i18n.t('dashboard.upstreamEditor.kimiCode.regions.overseas') }));
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.upstreamEditor.fields.apiKey')), { target: { value: 'sk-kimi-fake-replacement' } });
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.kimiCode.usage.load') }));
  expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ json: { record: expect.objectContaining({ config: { region: 'overseas', apiKey: 'sk-kimi-fake-replacement' } }) } }), expect.anything());
});

test('redacted read-only connections retain the subscription quota card', () => {
  renderInApp(<Harness readOnly />);
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: i18n.t('dashboard.upstreamEditor.kimiCode.usage.refresh') })).toBeNull();
});

test('Kimi Code model details lead with the catalog display name and show the pricing panel for unpriced models', () => {
  renderInApp(<ModelDetail
    onChange={() => {}} onDelete={() => {}} onSourceChange={() => {}} onUpstreamModelIdCommit={() => {}}
    readOnly record={kimiCodeRecord()} revealValidation={false} section="details" upstreamFlags={{}}
    row={{ key: 'auto:kimi-for-coding', source: 'auto', manualIndex: null, hasAuto: true, config: { upstreamModelId: 'kimi-for-coding', publicModelId: 'kimi-k2.8-preview', display_name: 'K2.8 Preview', kind: 'chat', endpoints: { openaiChatCompletions: {} } } }}
  />);
  expect(screen.getByRole('heading', { name: 'K2.8 Preview' })).toBeTruthy();
  expect(screen.getByDisplayValue('kimi-k2.8-preview')).toBeTruthy();
  expect(screen.queryByDisplayValue('kimi-for-coding')).toBeNull();
  expect(screen.getByRole('heading', { name: i18n.t('dashboard.upstreamEditor.models.pricing') })).toBeTruthy();
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
