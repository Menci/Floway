import { ArrowRouting24Regular, EyeOffRegular, EyeRegular, GlobeSearch24Regular } from '@fluentui/react-icons';
import type { InferResponseType } from 'hono/client';
import { useCallback, useMemo, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-providers-search';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import type { ControlPlaneModel, SearchConfig, UpstreamRecord } from '../api/types';
import jinaIconUrl from '../assets/jina-color.svg';
import microsoftIconUrl from '../assets/microsoft-color.svg';
import tavilyIconUrl from '../assets/tavily-color.svg';
import { eligibleSearchUpstreams, servesChatFor } from '../components/search/eligibility';
import { SEARCH_PROVIDER_LABEL_KEYS } from '../components/search/provider';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown, LISTBOX_POSITIONING } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS, TWO_COLUMN_FORM_CLASS } from '../components/ui/layout';
import { OpenLinkLabel } from '../components/ui/open-link-label';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SecretInput } from '../components/ui/secret-input';
import { SectionHeader } from '../components/ui/section-header';
import { SettingsExpander, SettingsSwitch } from '../components/ui/settings-card';
import { StatusBadge } from '../components/ui/status-badge';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { fluentComponents } from '../fluent';

type SearchConfigTestResult = InferResponseType<typeof api.api['search-config']['test']['$post'], 200>;

const {
  Button,
  Field,
  Link,
  Option,
  Text,
} = fluentComponents;

// `null` is a fetch that failed, distinct from a deployment that genuinely has
// no upstream: an empty catalog would report passthrough search as impossible.
interface LoaderData {
  config: SearchConfig;
  upstreams: UpstreamRecord[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
}

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  const [configResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api['search-config'].$get()),
    callApi(() => api.api.upstreams.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  if (configResult.error) throw new Error(configResult.error.message);
  return {
    config: configResult.data,
    upstreams: upstreamsResult.data ?? null,
    models: modelsResult.data?.data ?? null,
    error: upstreamsResult.error?.message ?? modelsResult.error?.message ?? null,
  };
}

// Marks keep their owner's colors, unlike the one-tone-per-provider upstream
// chips: nothing else in the row says who the third party is.
interface ProviderOption {
  value: SearchConfig['provider'];
  iconUrl?: string;
  url?: string;
  getApiKey: (config: SearchConfig) => string;
  setApiKey: (config: SearchConfig, key: string) => SearchConfig;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'disabled',
    getApiKey: () => '',
    setApiKey: c => c,
  },
  {
    value: 'tavily',
    iconUrl: tavilyIconUrl,
    url: 'https://app.tavily.com/',
    getApiKey: c => c.tavily.apiKey,
    setApiKey: (c, k) => ({ ...c, tavily: { apiKey: k } }),
  },
  {
    value: 'microsoft-web-iq',
    iconUrl: microsoftIconUrl,
    url: 'https://webiq.microsoft.ai/profiles',
    getApiKey: c => c.microsoftWebIq.apiKey,
    setApiKey: (c, k) => ({ ...c, microsoftWebIq: { apiKey: k } }),
  },
  {
    value: 'jina',
    iconUrl: jinaIconUrl,
    url: 'https://jina.ai/',
    getApiKey: c => c.jina.apiKey,
    setApiKey: (c, k) => ({ ...c, jina: { apiKey: k } }),
  },
];

export default function DashboardProvidersSearch({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [loadError, setLoadError] = useState(loaderData.error);
  const { models, upstreams } = loaderData;

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader
        description={t('dashboard.searchConfig.description')}
        title={t('dashboard.searchConfig.heading')}
      />

      {loadError && (
        <OutcomeMessageBar onDismiss={() => setLoadError(null)}>{loadError}</OutcomeMessageBar>
      )}

      {upstreams === null || models === null
        ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel>
        : <SearchSettings config={loaderData.config} models={models} upstreams={upstreams} />}
    </section>
  );
}

function SearchSettings({ config, models, upstreams }: {
  config: SearchConfig;
  models: ControlPlaneModel[];
  upstreams: UpstreamRecord[];
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [draft, setDraft] = useState<SearchConfig>(config);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SearchConfigTestResult | null>(
    null,
  );

  // The gateway may echo back a provider this build does not know. An
  // unrecognized id is named verbatim rather than collapsed onto a familiar one,
  // and its key field stays shut: this build has no field to store that key in,
  // so every keystroke into it would be discarded on save.
  const knownProviderLabel = (provider: string) => {
    const option = PROVIDER_OPTIONS.find(candidate => candidate.value === provider);
    return option ? t(SEARCH_PROVIDER_LABEL_KEYS[option.value]) : undefined;
  };
  const activeOption = PROVIDER_OPTIONS.find(option => option.value === draft.provider);
  const activeProviderLabel = knownProviderLabel(draft.provider)
    ?? t('dashboard.searchConfig.unavailable', { id: draft.provider });
  const eligibleUpstreams = useMemo(() => eligibleSearchUpstreams(upstreams, models), [models, upstreams]);
  const modelsForSelectedUpstream = useMemo(
    () => models.filter(model => servesChatFor(model, draft.passthroughOpenAiSearch.upstreamId)),
    [draft.passthroughOpenAiSearch.upstreamId, models],
  );
  const selectedUpstream = eligibleUpstreams.find(upstream => upstream.id === draft.passthroughOpenAiSearch.upstreamId);
  const selectedModel = modelsForSelectedUpstream.find(model => model.id === draft.passthroughOpenAiSearch.model);
  // A stored passthrough target the catalog no longer offers is named in its own
  // picker rather than left blank, and stays unchoosable because reselecting it
  // cannot resolve a model. Saving keeps it until the operator picks a live one.
  const unavailableUpstreamId = draft.passthroughOpenAiSearch.upstreamId !== '' && !selectedUpstream
    ? draft.passthroughOpenAiSearch.upstreamId
    : null;
  const unavailableModelId = draft.passthroughOpenAiSearch.model !== '' && !selectedModel
    ? draft.passthroughOpenAiSearch.model
    : null;

  const setPassthroughUpstream = useCallback((upstreamId: string, preferredModel?: string) => {
    const candidates = models.filter(model => servesChatFor(model, upstreamId));
    const model = candidates.find(candidate => candidate.id === preferredModel) ?? candidates[0];
    if (!model) throw new Error(`Search passthrough upstream ${upstreamId} has no chat model`);
    setDraft(current => ({
      ...current,
      passthroughOpenAiSearch: { enabled: true, upstreamId, model: model.id },
    }));
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
        setTestResult(null);
        setTestError(null);
      }
    },
    [],
  );

  const handleApiKeyChange = useCallback(
    (_: unknown, data: { value: string }) => {
      if (!activeOption) throw new Error(`Search provider ${draft.provider} has no API key field in this build`);
      setDraft(prev => activeOption.setApiKey(prev, data.value));
    },
    [activeOption, draft.provider],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const handle = toasts.start(t('dashboard.searchConfig.toast.save.pending'));
    const result = await callApi(() =>
      api.api['search-config'].$put({ json: draft }));
    setSaving(false);
    if (result.error) {
      handle.settle();
      setSaveError(result.error.message);
      return;
    }
    handle.succeed(t('dashboard.searchConfig.toast.save.success'));
  }, [draft, t, toasts]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    const result = await callApi(() => api.api['search-config'].test.$post({ json: draft }));
    setTesting(false);
    if (result.error) {
      // A failed probe is a structured test-result body at HTTP 400, and
      // rendering it keeps the upstream error code and the query visible. Every
      // other failure of this route carries a message and nothing to show.
      const raw = result.error.raw;
      if (raw && 'ok' in raw) setTestResult(raw);
      else setTestError(result.error.message);
      return;
    }
    setTestResult(result.data);
  }, [draft]);

  return (
    <>
      <SettingsExpander
        action={<Dropdown
          className="!w-auto flex-none"
          button={{
            children: (
              <ProviderOptionLabel
                iconUrl={activeOption?.iconUrl}
                label={activeProviderLabel}
              />
            ),
          }}
          listWidth="content"
          onOptionSelect={handleProviderChange}
          positioning={{ ...LISTBOX_POSITIONING, align: 'end' }}
          selectedOptions={[draft.provider]}
          value={activeProviderLabel}
        >
          {activeOption === undefined && <Option disabled text={draft.provider} value={draft.provider}>
            {activeProviderLabel}
          </Option>}
          {PROVIDER_OPTIONS.map(opt => (
            <Option key={opt.value} value={opt.value} text={t(SEARCH_PROVIDER_LABEL_KEYS[opt.value])}>
              <ProviderOptionLabel iconUrl={opt.iconUrl} label={t(SEARCH_PROVIDER_LABEL_KEYS[opt.value])} />
            </Option>
          ))}
        </Dropdown>}
        defaultOpen={draft.provider !== 'disabled'}
        description={t('dashboard.searchConfig.providerHint')}
        header={t('dashboard.searchConfig.providerLabel')}
        icon={<GlobeSearch24Regular />}
        toggledOn={draft.provider !== 'disabled'}
      >
        <div className="grid gap-3">
          <Field label={t('dashboard.searchConfig.apiKeyLabel')}>
            <SecretInput
              contentAfter={<TooltipIconButton
                icon={secretVisible ? <EyeOffRegular /> : <EyeRegular />}
                label={secretVisible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')}
                onClick={() => setSecretVisible(value => !value)}
              />}
              disabled={activeOption === undefined || draft.provider === 'disabled'}
              onChange={handleApiKeyChange}
              placeholder={t('dashboard.searchConfig.apiKeyPlaceholder')}
              revealed={secretVisible}
              value={activeOption?.getApiKey(draft) ?? ''}
            />
          </Field>
          {activeOption?.url && (
            <Link href={activeOption.url} target="_blank" rel="noopener noreferrer">
              <OpenLinkLabel>{t('dashboard.searchConfig.getKeyLink')}</OpenLinkLabel>
            </Link>
          )}
        </div>
      </SettingsExpander>

      <SettingsExpander
        action={<SettingsSwitch
          checked={draft.passthroughOpenAiSearch.enabled}
          disabled={eligibleUpstreams.length === 0}
          label={t('dashboard.searchConfig.passthrough.title')}
          onChange={togglePassthrough}
        />}
        defaultOpen={draft.passthroughOpenAiSearch.enabled}
        description={t('dashboard.searchConfig.passthrough.description')}
        header={t('dashboard.searchConfig.passthrough.title')}
        icon={<ArrowRouting24Regular />}
        toggledOn={draft.passthroughOpenAiSearch.enabled}
      >
        <div className="grid gap-3">
          <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
            <Field label={t('dashboard.searchConfig.passthrough.upstream')}>
              <Dropdown
                disabled={!draft.passthroughOpenAiSearch.enabled}
                onOptionSelect={(_, data) => data.optionValue && setPassthroughUpstream(data.optionValue)}
                selectedOptions={[draft.passthroughOpenAiSearch.upstreamId]}
                value={selectedUpstream?.name ?? (unavailableUpstreamId === null ? '' : t('dashboard.searchConfig.unavailable', { id: unavailableUpstreamId }))}
              >
                {unavailableUpstreamId !== null && <Option disabled text={unavailableUpstreamId} value={unavailableUpstreamId}>
                  {t('dashboard.searchConfig.unavailable', { id: unavailableUpstreamId })}
                </Option>}
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
                // The gate belongs here and not on the upstream picker beside
                // it: a picker closed by its own selection cannot be used to
                // leave that selection.
                disabled={!draft.passthroughOpenAiSearch.enabled || modelsForSelectedUpstream.length === 0}
                onOptionSelect={(_, data) => {
                  const model = data.optionValue;
                  if (!model) return;
                  setDraft(current => ({ ...current, passthroughOpenAiSearch: { ...current.passthroughOpenAiSearch, model } }));
                }}
                selectedOptions={[draft.passthroughOpenAiSearch.model]}
                value={selectedModel ? modelLabel(selectedModel) : (unavailableModelId === null ? '' : t('dashboard.searchConfig.unavailable', { id: unavailableModelId }))}
              >
                {unavailableModelId !== null && <Option disabled text={unavailableModelId} value={unavailableModelId}>
                  {t('dashboard.searchConfig.unavailable', { id: unavailableModelId })}
                </Option>}
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
          </div>
          {eligibleUpstreams.length === 0 && <Text size={200} className="text-fui-fg3">{t('dashboard.searchConfig.passthrough.empty')}</Text>}
        </div>
      </SettingsExpander>

      <div className="flex flex-col gap-[10px] sm:flex-row sm:items-center">
        <Button
          appearance="primary"
          disabledFocusable={saving}
          onClick={() => void handleSave()}
        >
          {t('dashboard.searchConfig.save')}
        </Button>
        <Button
          disabled={draft.provider === 'disabled'}
          disabledFocusable={testing}
          onClick={() => void handleTest()}
        >
          {t('dashboard.searchConfig.test')}
        </Button>
      </div>

      {saveError && (
        <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>
      )}
      {testError && (
        <OutcomeMessageBar onDismiss={() => setTestError(null)} title={t('dashboard.searchConfig.testFailed')}>{testError}</OutcomeMessageBar>
      )}

      {testResult && (
        <Panel className={PANEL_STACK_CLASS}>
          <SectionHeader level={2} title={t('dashboard.searchConfig.testResults')} />

          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge tone={testResult.ok ? 'success' : 'danger'}>
              {testResult.ok ? t('dashboard.searchConfig.testBadge.ok') : t('dashboard.searchConfig.testBadge.error')}
            </StatusBadge>
            <Text size={200} className="text-fui-fg3">
              {t('dashboard.searchConfig.testedProvider', {
                provider: knownProviderLabel(testResult.provider) ?? testResult.provider,
              })}
            </Text>
            {testResult.query && <Text size={200} className="text-fui-fg3">
              {t('dashboard.searchConfig.testedQuery', { query: testResult.query })}
            </Text>}
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
                    className="grid gap-1 border-0 border-t border-solid border-fui-divider py-3 first:border-t-0"
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <Link
                        className="font-fui-semibold"
                        href={r.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {r.title}
                      </Link>
                      {r.pageAge && (
                        <Text size={100} className="text-fui-fg3">
                          {t('dashboard.searchConfig.pageAge', {
                            age: r.pageAge,
                          })}
                        </Text>
                      )}
                    </div>
                    <Text size={100} className="text-fui-fg3 break-all">
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
            <OutcomeMessageBar onDismiss={() => setTestResult(null)} title={testResult.error.code}>
              {testResult.error.message}
            </OutcomeMessageBar>
          ) : null}
        </Panel>
      )}
    </>
  );
}

const modelLabel = (model: ControlPlaneModel) => model.display_name ?? model.id;

function DescribedOptionLabel({ description, label }: { description?: string; label: string }) {
  return (
    <span className="grid gap-0.5 min-w-0">
      <span className="truncate">{label}</span>
      {description && (
        <Text block size={100} className="text-fui-fg3" truncate wrap={false}>
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
