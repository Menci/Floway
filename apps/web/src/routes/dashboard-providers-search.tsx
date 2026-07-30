import { EyeOffRegular, EyeRegular } from '@fluentui/react-icons';
import type { InferResponseType } from 'hono/client';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-search';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ControlPlaneModel, SearchConfig, UpstreamRecord } from '../api/types';
import jinaIconUrl from '../assets/icons/jina-color.svg';
import microsoftIconUrl from '../assets/icons/microsoft-color.svg';
import tavilyIconUrl from '../assets/icons/tavily-color.svg';
import { getSessionToken } from '../auth/session';
import { AdminOnlyNotice } from '../components/admin-only-notice';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { Panel } from '../components/ui/panel';
import { SecretInput } from '../components/ui/secret-input';
import { fluentComponents } from '../fluent';
import { useAuthStore } from '../stores/auth-store';

type SearchConfigTestResult = InferResponseType<typeof api.api['search-config']['test']['$post'], 200>;

const {
  Badge,
  Button,
  Field,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Switch,
  Text,
  Tooltip,
} = fluentComponents;

interface AdminSearchPageLoaderData {
  admin: true;
  config: SearchConfig;
  upstreams: UpstreamRecord[];
  models: ControlPlaneModel[];
  error: string | null;
}

type SearchPageLoaderData = AdminSearchPageLoaderData | { admin: false };

export async function clientLoader(): Promise<SearchPageLoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  if (!user.isAdmin) return { admin: false };
  const [configResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api['search-config'].$get()),
    callApi(() => api.api.upstreams.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  if (configResult.error) throw new Error(configResult.error.message);
  return {
    admin: true,
    config: configResult.data,
    upstreams: upstreamsResult.data ?? [],
    models: modelsResult.data?.data ?? [],
    error: upstreamsResult.error?.message ?? modelsResult.error?.message ?? null,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Provider Search | Floway' }];
}

export const eligibleSearchUpstreams = (upstreams: readonly UpstreamRecord[], models: readonly ControlPlaneModel[]) =>
  upstreams.filter(upstream => upstream.enabled
    && (upstream.kind === 'codex' || upstream.kind === 'custom')
    && models.some(model => model.kind === 'chat' && model.upstreams.some(binding => binding.id === upstream.id)));

// A search provider is a third party the operator recognizes by its mark, so
// each mark is shown in its owner's colors. This is the opposite call from the
// upstream chips, where one tone per provider is itself the identity; in this
// list nothing else in the row says who the party is.
interface ProviderOption {
  value: SearchConfig['provider'];
  labelKey: string;
  iconUrl?: string;
  descKey?: string;
  url?: string;
  getApiKey: (config: SearchConfig) => string;
  setApiKey: (config: SearchConfig, key: string) => SearchConfig;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'disabled',
    labelKey: 'dashboard.searchConfig.provider.disabled',
    getApiKey: () => '',
    setApiKey: c => c,
  },
  {
    value: 'tavily',
    labelKey: 'dashboard.searchConfig.provider.tavily',
    iconUrl: tavilyIconUrl,
    descKey: 'dashboard.searchConfig.providerDescTavily',
    url: 'https://app.tavily.com/',
    getApiKey: c => c.tavily.apiKey,
    setApiKey: (c, k) => ({ ...c, tavily: { apiKey: k } }),
  },
  {
    value: 'microsoft-web-iq',
    labelKey: 'dashboard.searchConfig.provider.microsoftWebIq',
    iconUrl: microsoftIconUrl,
    descKey: 'dashboard.searchConfig.providerDescMicrosoftWebIq',
    url: 'https://webiq.microsoft.ai/profiles',
    getApiKey: c => c.microsoftWebIq.apiKey,
    setApiKey: (c, k) => ({ ...c, microsoftWebIq: { apiKey: k } }),
  },
  {
    value: 'jina',
    labelKey: 'dashboard.searchConfig.provider.jina',
    iconUrl: jinaIconUrl,
    descKey: 'dashboard.searchConfig.providerDescJina',
    url: 'https://jina.ai/',
    getApiKey: c => c.jina.apiKey,
    setApiKey: (c, k) => ({ ...c, jina: { apiKey: k } }),
  },
];

function findProviderOption(
  provider: SearchConfig['provider'],
): ProviderOption {
  return (
    PROVIDER_OPTIONS.find(o => o.value === provider) ?? PROVIDER_OPTIONS[0]
  );
}

export default function DashboardProvidersSearch({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  if (!loaderData.admin) {
    return (
      <section className="dashboard-page max-w-[960px]">
        <DashboardPageHeader
          description={t('dashboard.searchConfig.description')}
          eyebrow={t('dashboard.groups.providers')}
          title={t('dashboard.searchConfig.heading')}
        />
        <AdminOnlyNotice />
      </section>
    );
  }
  return <AdminSearchPage loaderData={loaderData} />;
}

function AdminSearchPage({ loaderData }: { loaderData: AdminSearchPageLoaderData }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SearchConfig>(loaderData.config);
  const upstreams = loaderData.upstreams;
  const models = loaderData.models;
  const loadError = loaderData.error;

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SearchConfigTestResult | null>(
    null,
  );

  const activeOption = findProviderOption(draft.provider);
  // The tested provider is whatever the gateway echoed back, which need not be
  // one this build knows about; an unrecognized id is shown verbatim rather
  // than collapsed onto a familiar one.
  const testedOption = PROVIDER_OPTIONS.find(option => option.value === testResult?.provider);
  const testedProviderLabel = testedOption ? t(testedOption.labelKey) : testResult?.provider;
  const eligibleUpstreams = useMemo(() => eligibleSearchUpstreams(upstreams, models), [models, upstreams]);
  const modelsForSelectedUpstream = useMemo(() => models.filter(model =>
    model.kind === 'chat' && model.upstreams.some(binding => binding.id === draft.passthroughOpenAiSearch.upstreamId)), [draft.passthroughOpenAiSearch.upstreamId, models]);
  const selectedUpstream = eligibleUpstreams.find(upstream => upstream.id === draft.passthroughOpenAiSearch.upstreamId);
  const selectedModel = modelsForSelectedUpstream.find(model => model.id === draft.passthroughOpenAiSearch.model);

  const setPassthroughUpstream = useCallback((upstreamId: string, preferredModel?: string) => {
    const candidates = models.filter(model => model.kind === 'chat'
      && model.upstreams.some(binding => binding.id === upstreamId));
    const model = candidates.find(candidate => candidate.id === preferredModel) ?? candidates[0];
    if (!model) throw new Error(`Search passthrough upstream ${upstreamId} has no chat model`);
    setDraft(current => ({
      ...current,
      passthroughOpenAiSearch: { enabled: true, upstreamId, model: model.id },
    }));
    setSaveSuccess(false);
  }, [models]);

  const togglePassthrough = useCallback((enabled: boolean) => {
    if (!enabled) {
      setDraft(current => ({ ...current, passthroughOpenAiSearch: { ...current.passthroughOpenAiSearch, enabled: false } }));
      return;
    }
    const selected = eligibleUpstreams.find(upstream => upstream.id === draft.passthroughOpenAiSearch.upstreamId)
      ?? eligibleUpstreams[0];
    if (!selected) throw new Error('Search passthrough requires an eligible upstream');
    setPassthroughUpstream(selected.id, draft.passthroughOpenAiSearch.model);
  }, [draft.passthroughOpenAiSearch, eligibleUpstreams, setPassthroughUpstream]);

  const handleProviderChange = useCallback(
    (_: unknown, data: { optionValue?: string }) => {
      if (data.optionValue) {
        setDraft(prev => ({
          ...prev,
          provider: data.optionValue as SearchConfig['provider'],
        }));
        setSaveSuccess(false);
        setTestResult(null);
      }
    },
    [],
  );

  const handleApiKeyChange = useCallback(
    (_: unknown, data: { value: string }) => {
      setDraft(prev => activeOption.setApiKey(prev, data.value));
      setSaveSuccess(false);
    },
    [activeOption],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    const result = await callApi(() =>
      api.api['search-config'].$put({ json: draft }));
    setSaving(false);
    if (result.error) {
      setSaveError(result.error.message);
    } else {
      setSaveSuccess(true);
    }
  }, [draft]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await api.api['search-config'].test.$post({ json: draft });
      // Probe failures are structured SearchTestResult bodies at HTTP 400;
      // preserving that body keeps the upstream error code and query visible.
      const result = await response.json();
      if (!('ok' in result)) throw new Error(result.error);
      setTestResult(result);
    } catch (e) {
      setTestResult({
        ok: false,
        provider: draft.provider,
        query: '',
        error: {
          code: 'NETWORK',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    } finally {
      setTesting(false);
    }
  }, [draft]);

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader
        description={t('dashboard.searchConfig.description')}
        eyebrow={t('dashboard.groups.providers')}
        title={t('dashboard.searchConfig.heading')}
      />

      <Panel className="!p-[22px_24px] grid">
        {loadError && (
          <MessageBar intent="error">
            <MessageBarBody>{loadError}</MessageBarBody>
          </MessageBar>
        )}

        <Field label={t('dashboard.searchConfig.providerLabel')}>
          <Dropdown
            button={{
              children: (
                <ProviderOptionLabel
                  iconUrl={activeOption.iconUrl}
                  label={t(activeOption.labelKey)}
                />
              ),
            }}
            onOptionSelect={handleProviderChange}
            selectedOptions={[draft.provider]}
            value={t(activeOption.labelKey)}
          >
            {PROVIDER_OPTIONS.map(opt => (
              <Option key={opt.value} value={opt.value} text={t(opt.labelKey)}>
                <ProviderOptionLabel iconUrl={opt.iconUrl} label={t(opt.labelKey)} />
              </Option>
            ))}
          </Dropdown>
        </Field>

        {activeOption.descKey && (
          <div className="grid gap-[4px]">
            <Text size={200} className="text-fui-fg3">
              {t(activeOption.descKey)}
            </Text>
            {activeOption.url && (
              <Link href={activeOption.url} target="_blank" rel="noopener noreferrer">
                {t('dashboard.searchConfig.getKeyLink')}
              </Link>
            )}
          </div>
        )}

        {draft.provider === 'disabled'
          ? <MessageBar intent="info"><MessageBarBody>{t('dashboard.searchConfig.noCredentialNeeded')}</MessageBarBody></MessageBar>
          : (
              <Field label={t('dashboard.searchConfig.apiKeyLabel')}>
                <SecretInput
                  contentAfter={<Tooltip content={secretVisible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')} relationship="label"><Button appearance="subtle" aria-label={secretVisible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')} icon={secretVisible ? <EyeOffRegular /> : <EyeRegular />} onClick={() => setSecretVisible(value => !value)} size="small" /></Tooltip>}
                  onChange={handleApiKeyChange}
                  placeholder={t('dashboard.searchConfig.apiKeyPlaceholder')}
                  revealed={secretVisible}
                  value={activeOption.getApiKey(draft)}
                />
              </Field>
            )}

        <section className="grid gap-3 border-t border-t-solid border-fui-stroke1 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1 min-w-0">
              <Text weight="semibold">{t('dashboard.searchConfig.passthrough.title')}</Text>
              <Text size={200} className="text-fui-fg2">{t('dashboard.searchConfig.passthrough.description')}</Text>
            </div>
            <Switch
              aria-label={t('dashboard.searchConfig.passthrough.title')}
              checked={draft.passthroughOpenAiSearch.enabled}
              disabled={eligibleUpstreams.length === 0}
              onChange={(_, data) => togglePassthrough(data.checked)}
            />
          </div>
          {draft.passthroughOpenAiSearch.enabled && <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
            <Field label={t('dashboard.searchConfig.passthrough.upstream')}>
              <Dropdown
                onOptionSelect={(_, data) => data.optionValue && setPassthroughUpstream(data.optionValue)}
                selectedOptions={[draft.passthroughOpenAiSearch.upstreamId]}
                value={selectedUpstream?.name ?? ''}
              >
                {eligibleUpstreams.map(upstream => (
                  <Option key={upstream.id} text={upstream.name} value={upstream.id}>
                    <DescribedOptionLabel
                      description={t(`dashboard.upstreams.providers.${upstream.kind}`)}
                      label={upstream.name}
                    />
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('dashboard.searchConfig.passthrough.model')}>
              <Dropdown
                onOptionSelect={(_, data) => {
                  const model = data.optionValue;
                  if (!model) return;
                  setDraft(current => ({ ...current, passthroughOpenAiSearch: { ...current.passthroughOpenAiSearch, model } }));
                  setSaveSuccess(false);
                }}
                selectedOptions={[draft.passthroughOpenAiSearch.model]}
                value={selectedModel ? modelLabel(selectedModel) : ''}
              >
                {modelsForSelectedUpstream.map(model => (
                  <Option key={model.id} text={modelLabel(model)} value={model.id}>
                    <DescribedOptionLabel
                      description={modelLabel(model) === model.id ? undefined : model.id}
                      label={modelLabel(model)}
                    />
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>}
          {eligibleUpstreams.length === 0 && <Text size={200} className="text-fui-fg3">{t('dashboard.searchConfig.passthrough.empty')}</Text>}
        </section>

        <div className="flex flex-col gap-[10px] sm:flex-row sm:items-center">
          <Button
            appearance="primary"
            disabled={saving}
            icon={saving ? <Spinner size="tiny" /> : undefined}
            onClick={() => void handleSave()}
          >
            {saving
              ? t('dashboard.searchConfig.saving')
              : t('dashboard.searchConfig.save')}
          </Button>
          <Button
            disabled={draft.provider === 'disabled' || testing}
            icon={testing ? <Spinner size="tiny" /> : undefined}
            onClick={() => void handleTest()}
          >
            {testing
              ? t('dashboard.searchConfig.testing')
              : t('dashboard.searchConfig.test')}
          </Button>
        </div>

        {draft.provider === 'disabled' && (
          <Text size={200} className="text-fui-fg3">
            {t('dashboard.searchConfig.testDisabledHint')}
          </Text>
        )}

        {saveError && (
          <MessageBar intent="error">
            <MessageBarBody>{saveError}</MessageBarBody>
          </MessageBar>
        )}
        {saveSuccess && (
          <MessageBar intent="success">
            <MessageBarBody>
              {t('dashboard.searchConfig.saveSuccess')}
            </MessageBarBody>
          </MessageBar>
        )}
      </Panel>

      {testResult && (
        <Panel className="!p-[22px_24px] grid gap-[14px]">
          <Text as="h2" size={400} weight="semibold" className="m-0">
            {t('dashboard.searchConfig.testResults')}
          </Text>

          <div className="flex items-center gap-[8px] flex-wrap">
            <Badge appearance="tint" color={testResult.ok ? 'success' : 'danger'}>
              {testResult.ok ? 'OK' : 'Error'}
            </Badge>
            <Text size={200} className="text-fui-fg3">
              {t('dashboard.searchConfig.testedProvider', { provider: testedProviderLabel })}
              {testResult.query ? ` · ${t('dashboard.searchConfig.testedQuery', { query: testResult.query })}` : ''}
            </Text>
          </div>

          {testResult.ok && testResult.results ? (
            testResult.results.length === 0 ? (
              <Text size={200} className="text-fui-fg3">
                {t('dashboard.searchConfig.testSuccess', { count: 0 })}
              </Text>
            ) : (
              <ul className="m-0 p-0 list-none">
                {testResult.results.map(r => (
                  <li
                    key={r.url + r.title}
                    className="grid gap-1 border-0 border-t border-solid border-fui-stroke1 py-3 first:border-t-0"
                  >
                    <div className="flex items-baseline gap-[8px] flex-wrap">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-fui-brand1 no-underline hover:underline font-semibold text-[14px]"
                      >
                        {r.title}
                      </a>
                      {r.pageAge && (
                        <Text size={100} className="text-fui-fg3">
                          {t('dashboard.searchConfig.pageAge', {
                            age: r.pageAge,
                          })}
                        </Text>
                      )}
                    </div>
                    <Text
                      size={100}
                      className="text-fui-fg3"
                      style={{ wordBreak: 'break-all' }}
                    >
                      {r.url}
                    </Text>
                    <Text size={200} className="text-fui-fg2">
                      {r.previewText}
                    </Text>
                  </li>
                ))}
              </ul>
            )
          ) : !testResult.ok ? (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>{testResult.error.code}</MessageBarTitle>
                {testResult.error.message}
              </MessageBarBody>
            </MessageBar>
          ) : null}
        </Panel>
      )}
    </section>
  );
}

// A model's display name is often just its id; showing both would read as a
// stutter, so the second line only appears when it carries something new.
const modelLabel = (model: ControlPlaneModel) => model.display_name ?? model.id;

function DescribedOptionLabel({ description, label }: { description?: string; label: string }) {
  return (
    <span className="grid gap-[2px] min-w-0">
      <span className="truncate">{label}</span>
      {description && (
        <Text size={100} className="text-fui-fg3 truncate">
          {description}
        </Text>
      )}
    </span>
  );
}

function ProviderOptionLabel({ iconUrl, label }: { iconUrl?: string; label: string }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      {iconUrl && <img alt="" className="block h-[16px] w-[16px] flex-none" src={iconUrl} />}
      <span className="truncate">{label}</span>
    </span>
  );
}
