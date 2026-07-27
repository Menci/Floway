import { useCallback, useMemo, useState } from "react";
import { redirect } from "react-router";
import { useTranslation } from "react-i18next";

import type { Route } from "./+types/dashboard-providers-search";
import type { InferResponseType } from "hono/client";

import type { ControlPlaneModel, SearchConfig, UpstreamRecord } from "../api/types";
import { authFetch, callApi } from "../api/auth";
import { api } from "../api/client";

type SearchConfigTestResult = InferResponseType<typeof api.api["search-config"]["test"]["$post"], 200>;
type SearchConfigTestFailure = Extract<SearchConfigTestResult, { ok: false }>;
import { getSessionToken } from "../auth/session";
import bingIconUrl from "../assets/bing.svg";
import jinaIconUrl from "../assets/jina.svg";
import tavilyIconUrl from "../assets/tavily.svg";
import { Dropdown, Input, Select } from "../components/ui/fluent-form-controls";
import { Panel } from "../components/ui/panel";
import { fluentComponents } from "../fluent";
import { useDashboardOutletContext } from "./dashboard";

const {
  Button,
  Field,
  Link,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Switch,
  Text,
} = fluentComponents;

interface SearchPageLoaderData {
  config: SearchConfig;
  upstreams: UpstreamRecord[];
  models: ControlPlaneModel[];
  error: string | null;
}

export async function clientLoader(): Promise<SearchPageLoaderData> {
  if (!getSessionToken()) throw redirect("/");
  const [configResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi<SearchConfig>(() => api.api["search-config"].$get()),
    callApi<UpstreamRecord[]>(() => api.api.upstreams.$get()),
    callApi<ModelsResponse>(() => api.api.models.$get({ query: { aliases: "false", include_unlisted: "true" } })),
  ]);
  return {
    config: configResult.data ?? DEFAULT_CONFIG,
    upstreams: upstreamsResult.data ?? [],
    models: modelsResult.data?.data ?? [],
    error: configResult.error?.message ?? upstreamsResult.error?.message ?? modelsResult.error?.message ?? null,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Provider Search | Floway" }];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SearchConfig = {
  provider: "disabled",
  tavily: { apiKey: "" },
  microsoftGrounding: { apiKey: "" },
  jina: { apiKey: "" },
  passthroughOpenAiSearch: { enabled: false, upstreamId: "", model: "" },
};

interface ModelsResponse { object: string; data: ControlPlaneModel[] }

export const eligibleSearchUpstreams = (upstreams: readonly UpstreamRecord[], models: readonly ControlPlaneModel[]) =>
  upstreams.filter((upstream) => upstream.enabled
    && (upstream.kind === "codex" || upstream.kind === "custom")
    && models.some((model) => model.kind === "chat" && model.upstreams.some((binding) => binding.id === upstream.id)));

interface ProviderOption {
  value: SearchConfig["provider"];
  labelKey: string;
  iconUrl?: string;
  descKey?: string;
  url?: string;
  getApiKey: (config: SearchConfig) => string;
  setApiKey: (config: SearchConfig, key: string) => SearchConfig;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: "disabled",
    labelKey: "dashboard.searchConfig.provider.disabled",
    getApiKey: () => "",
    setApiKey: (c) => c,
  },
  {
    value: "tavily",
    labelKey: "dashboard.searchConfig.provider.tavily",
    iconUrl: tavilyIconUrl,
    descKey: "dashboard.searchConfig.providerDescTavily",
    url: "https://app.tavily.com/",
    getApiKey: (c) => c.tavily.apiKey,
    setApiKey: (c, k) => ({ ...c, tavily: { apiKey: k } }),
  },
  {
    value: "microsoft-grounding",
    labelKey: "dashboard.searchConfig.provider.microsoftGrounding",
    iconUrl: bingIconUrl,
    descKey: "dashboard.searchConfig.providerDescMicrosoftGrounding",
    url: "https://www.microsoft.com/en-us/bing/apis",
    getApiKey: (c) => c.microsoftGrounding.apiKey,
    setApiKey: (c, k) => ({ ...c, microsoftGrounding: { apiKey: k } }),
  },
  {
    value: "jina",
    labelKey: "dashboard.searchConfig.provider.jina",
    iconUrl: jinaIconUrl,
    descKey: "dashboard.searchConfig.providerDescJina",
    url: "https://jina.ai/",
    getApiKey: (c) => c.jina.apiKey,
    setApiKey: (c, k) => ({ ...c, jina: { apiKey: k } }),
  },
];

function findProviderOption(
  provider: SearchConfig["provider"],
): ProviderOption {
  return (
    PROVIDER_OPTIONS.find((o) => o.value === provider) ?? PROVIDER_OPTIONS[0]
  );
}

function SearchPageHeader() {
  const { t } = useTranslation();

  return (
    <header className="grid gap-[6px]">
      <Text
        size={200}
        weight="semibold"
        className="text-fui-fg2 leading-[1.2] uppercase"
      >
        {t("dashboard.groups.providers")}
      </Text>
      <Text size={700} weight="semibold">
        {t("dashboard.searchConfig.heading")}
      </Text>
      <Text size={300} className="text-fui-fg2 leading-[1.45] max-w-[760px]">
        {t("dashboard.searchConfig.description")}
      </Text>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DashboardProvidersSearch({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  // Draft state
  const [draft, setDraft] = useState<SearchConfig>(loaderData.config);
  const upstreams = loaderData.upstreams;
  const models = loaderData.models;
  const loadError = loaderData.error;

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SearchConfigTestResult | null>(
    null,
  );

  const activeOption = findProviderOption(draft.provider);
  const eligibleUpstreams = useMemo(() => eligibleSearchUpstreams(upstreams, models), [models, upstreams]);
  const modelsForSelectedUpstream = useMemo(() => models.filter((model) =>
    model.kind === "chat" && model.upstreams.some((binding) => binding.id === draft.passthroughOpenAiSearch.upstreamId)), [draft.passthroughOpenAiSearch.upstreamId, models]);

  const setPassthroughUpstream = useCallback((upstreamId: string, preferredModel?: string) => {
    const candidates = models.filter((model) => model.kind === "chat"
      && model.upstreams.some((binding) => binding.id === upstreamId));
    const model = candidates.find((candidate) => candidate.id === preferredModel) ?? candidates[0];
    setDraft((current) => ({
      ...current,
      passthroughOpenAiSearch: { enabled: true, upstreamId, model: model?.id ?? "" },
    }));
    setSaveSuccess(false);
  }, [models]);

  const togglePassthrough = useCallback((enabled: boolean) => {
    if (!enabled) {
      setDraft((current) => ({ ...current, passthroughOpenAiSearch: { ...current.passthroughOpenAiSearch, enabled: false } }));
      return;
    }
    const selected = eligibleUpstreams.find((upstream) => upstream.id === draft.passthroughOpenAiSearch.upstreamId)
      ?? eligibleUpstreams[0];
    if (selected) setPassthroughUpstream(selected.id, draft.passthroughOpenAiSearch.model);
  }, [draft.passthroughOpenAiSearch, eligibleUpstreams, setPassthroughUpstream]);

  // Handlers
  const handleProviderChange = useCallback(
    (_: unknown, data: { optionValue?: string }) => {
      if (data.optionValue) {
        setDraft((prev) => ({
          ...prev,
          provider: data.optionValue as SearchConfig["provider"],
        }));
        setSaveSuccess(false);
        setTestResult(null);
      }
    },
    [],
  );

  const handleApiKeyChange = useCallback(
    (_: unknown, data: { value: string }) => {
      setDraft((prev) => activeOption.setApiKey(prev, data.value));
      setSaveSuccess(false);
    },
    [activeOption],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    const result = await callApi<SearchConfig>(() =>
      api.api["search-config"].$put({ json: draft }),
    );
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
      const response = await api.api["search-config"].test.$post({ json: draft });
      // A completed probe answers 200 whether or not the provider accepted it;
      // any other status is a control-plane failure, not a probe result.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTestResult(await response.json());
    } catch (e) {
      setTestResult({
        ok: false,
        provider: draft.provider,
        query: "",
        error: {
          code: "NETWORK",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    } finally {
      setTesting(false);
    }
  }, [draft]);

  // ---- admin guard ----
  if (!user.isAdmin) {
    return (
      <section className="grid gap-[18px] max-w-[960px] min-w-0">
        <SearchPageHeader />
        <Panel className="!p-[22px_24px]">
          <div className="grid gap-[10px] max-w-[680px]">
            <Text
              size={300}
              weight="semibold"
              style={{ color: "light-dark(#0f6cbd, #75b6f7)" }}
            >
              {t("dashboard.pages.adminOnly")}
            </Text>
            <Text size={300} className="text-fui-fg3">
              {t("dashboard.pages.adminOnlyDescription")}
            </Text>
          </div>
        </Panel>
      </section>
    );
  }

  // ---- main render ----
  return (
    <section className="grid gap-[18px] max-w-[960px] min-w-0">
      {/* Page header */}
      <SearchPageHeader />

      {/* Config panel */}
      <Panel className="!p-[22px_24px] grid gap-[16px]">
        {loadError && (
          <MessageBar intent="error">
            <MessageBarBody>{loadError}</MessageBarBody>
          </MessageBar>
        )}

        {/* Provider selector */}
        <Field label={t("dashboard.searchConfig.providerLabel")}>
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
            {PROVIDER_OPTIONS.map((opt) => (
              <Option key={opt.value} value={opt.value} text={t(opt.labelKey)}>
                <ProviderOptionLabel iconUrl={opt.iconUrl} label={t(opt.labelKey)} />
              </Option>
            ))}
          </Dropdown>
        </Field>

        {/* Provider description + get key link */}
        {activeOption.descKey && (
          <div className="grid gap-[4px]">
            <Text size={200} className="text-fui-fg3">
              {t(activeOption.descKey)}
            </Text>
            {activeOption.url && (
              <Link href={activeOption.url} target="_blank" rel="noopener noreferrer">
                {t("dashboard.searchConfig.getKeyLink")}
              </Link>
            )}
          </div>
        )}

        {/* API Key input */}
        {draft.provider === "disabled" ? (
          <Field label={t("dashboard.searchConfig.apiKeyLabel")}>
            <Input
              disabled
              value={t("dashboard.searchConfig.noCredentialNeeded")}
            />
          </Field>
        ) : (
          <Field label={t("dashboard.searchConfig.apiKeyLabel")}>
            <Input
              onChange={handleApiKeyChange}
              placeholder={t("dashboard.searchConfig.apiKeyPlaceholder")}
              type="password"
              value={activeOption.getApiKey(draft)}
            />
          </Field>
        )}

        <section className="grid gap-3 border-t border-t-solid border-fui-stroke1 pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1 min-w-0">
              <Text weight="semibold">{t("dashboard.searchConfig.passthrough.title")}</Text>
              <Text size={200} className="text-fui-fg2">{t("dashboard.searchConfig.passthrough.description")}</Text>
            </div>
            <Switch
              aria-label={t("dashboard.searchConfig.passthrough.title")}
              checked={draft.passthroughOpenAiSearch.enabled}
              disabled={eligibleUpstreams.length === 0}
              onChange={(_, data) => togglePassthrough(data.checked)}
            />
          </div>
          {draft.passthroughOpenAiSearch.enabled && <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
            <Field label={t("dashboard.searchConfig.passthrough.upstream")}>
              <Select value={draft.passthroughOpenAiSearch.upstreamId} onChange={(_, data) => setPassthroughUpstream(data.value)}>
                {eligibleUpstreams.map((upstream) => <option key={upstream.id} value={upstream.id}>{upstream.name}</option>)}
              </Select>
            </Field>
            <Field label={t("dashboard.searchConfig.passthrough.model")}>
              <Select value={draft.passthroughOpenAiSearch.model} onChange={(_, data) => setDraft((current) => ({ ...current, passthroughOpenAiSearch: { ...current.passthroughOpenAiSearch, model: data.value } }))}>
                {modelsForSelectedUpstream.map((model) => <option key={model.id} value={model.id}>{model.display_name ?? model.id}</option>)}
              </Select>
            </Field>
          </div>}
          {eligibleUpstreams.length === 0 && <Text size={200} className="text-fui-fg3">{t("dashboard.searchConfig.passthrough.empty")}</Text>}
        </section>

        {/* Actions */}
        <div className="flex flex-col gap-[10px] sm:flex-row sm:items-center">
          <Button
            appearance="primary"
            disabled={saving}
            icon={saving ? <Spinner size="tiny" /> : undefined}
            onClick={handleSave}
          >
            {saving
              ? t("dashboard.searchConfig.saving")
              : t("dashboard.searchConfig.save")}
          </Button>
          <Button
            disabled={draft.provider === "disabled" || testing}
            icon={testing ? <Spinner size="tiny" /> : undefined}
            onClick={handleTest}
          >
            {testing
              ? t("dashboard.searchConfig.testing")
              : t("dashboard.searchConfig.test")}
          </Button>
        </div>

        {draft.provider === "disabled" && (
          <Text size={200} className="text-fui-fg3">
            {t("dashboard.searchConfig.testDisabledHint")}
          </Text>
        )}

        {/* Messages */}
        {saveError && (
          <MessageBar intent="error">
            <MessageBarBody>{saveError}</MessageBarBody>
          </MessageBar>
        )}
        {saveSuccess && (
          <MessageBar intent="success">
            <MessageBarBody>
              {t("dashboard.searchConfig.saveSuccess")}
            </MessageBarBody>
          </MessageBar>
        )}
      </Panel>

      {/* Test results */}
      {testResult && (
        <Panel className="!p-[22px_24px] grid gap-[14px]">
          <Text size={400} weight="semibold">
            {t("dashboard.searchConfig.testResults")}
          </Text>

          {/* Status badge + meta */}
          <div className="flex items-center gap-[8px] flex-wrap">
            {testResult.ok ? (
              <span
                className="text-[10px] font-bold uppercase px-[6px] py-[2px] rounded-[3px]"
                style={{
                  backgroundColor: "light-dark(#ddf6dd, #1b3a1b)",
                  color: "light-dark(#0b6a0b, #6fcf6f)",
                }}
              >
                OK
              </span>
            ) : (
              <span
                className="text-[10px] font-bold uppercase px-[6px] py-[2px] rounded-[3px]"
                style={{
                  backgroundColor: "light-dark(#fde7e9, #3d1517)",
                  color: "light-dark(#c50f1f, #e37b84)",
                }}
              >
                Error
              </span>
            )}
            <Text size={200} className="text-fui-fg3">
              Provider: {testResult.provider}
              {testResult.query ? ` · Query: ${testResult.query}` : ""}
            </Text>
          </div>

          {/* Results */}
          {testResult.ok && testResult.results ? (
            testResult.results.length === 0 ? (
              <Text size={200} className="text-fui-fg3">
                {t("dashboard.searchConfig.testSuccess", { count: 0 })}
              </Text>
            ) : (
              <div className="grid gap-[10px]">
                {testResult.results.map((r) => (
                  <div
                    key={r.url + r.title}
                    className="rounded-lg border border-solid border-fui-stroke1 !p-[12px_14px] grid gap-[4px]"
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
                          {t("dashboard.searchConfig.pageAge", {
                            age: r.pageAge,
                          })}
                        </Text>
                      )}
                    </div>
                    <Text
                      size={100}
                      className="text-fui-fg3"
                      style={{ wordBreak: "break-all" }}
                    >
                      {r.url}
                    </Text>
                    <Text size={200} className="text-fui-fg2">
                      {r.previewText}
                    </Text>
                  </div>
                ))}
              </div>
            )
          ) : !testResult.ok ? (
            <div
              className="rounded-lg border border-solid p-[12px_14px] grid gap-[4px]"
              style={{
                borderColor: "light-dark(#c50f1f, #e37b84)",
                backgroundColor: "light-dark(#fde7e9, #3d1517)",
              }}
            >
              <Text
                size={200}
                weight="semibold"
                style={{ color: "light-dark(#c50f1f, #e37b84)" }}
              >
                {(testResult as SearchConfigTestFailure).error.code}
              </Text>
              <Text size={200} className="text-fui-fg1">
                {(testResult as SearchConfigTestFailure).error.message}
              </Text>
            </div>
          ) : null}
        </Panel>
      )}
    </section>
  );
}

function ProviderOptionLabel({ iconUrl, label }: { iconUrl?: string; label: string }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      {iconUrl && (
        <img
          alt=""
          aria-hidden="true"
          className="block flex-none h-[16px] w-[16px]"
          src={iconUrl}
          style={{ filter: "light-dark(none, invert(1))" }}
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
