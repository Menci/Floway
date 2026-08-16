import { CheckmarkCircleRegular, ScanTypeRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { previewRecord } from './data';
import { OAuthCallbackImport } from './oauth-callback-import';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { Input, Textarea } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SecretInput } from '../ui/secret-input';
import { StatusBadge } from '../ui/status-badge';

const { Button, Field, Radio, RadioGroup, Spinner, Tab, TabList, Text } = fluentComponents;

type CodexRecord = Extract<UpstreamRecord, { kind: 'codex' }>;
type PreviewCandidate = Awaited<ReturnType<typeof previewJson>>['candidates'][number];

const previewJson = async (rawJson: string) => {
  const result = await callApi(() => api.api.upstreams.codex.import.preview.$post({ json: { raw_json: rawJson } }));
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

type ManualDraft = {
  accessToken: string;
  accountId: string;
  refreshToken: string;
  idToken: string;
  email: string;
  planType: string;
  expiresAt: string;
};

const EMPTY_MANUAL: ManualDraft = {
  accessToken: '', accountId: '', refreshToken: '', idToken: '', email: '', planType: '', expiresAt: '',
};

const trimmed = (value: string): string | undefined => {
  const next = value.trim();
  return next.length > 0 ? next : undefined;
};

export function CodexImportForm({ hasAccount, onImported, record }: {
  hasAccount: boolean;
  onImported: (patch: { config?: unknown; state?: unknown }) => void;
  record: CodexRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { getValues } = useFormContext<UpstreamEditorValues>();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;

  const [tab, setTab] = useState('json');
  const [json, setJson] = useState('');
  const [previewedJson, setPreviewedJson] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PreviewCandidate[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [manual, setManual] = useState(EMPTY_MANUAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A preview names one account inside one document, so editing the document
  // invalidates the choice made against it.
  const editJson = (next: string) => {
    setJson(next);
    setPreviewedJson(null);
    setCandidates([]);
    setSelected(null);
    setError(null);
  };

  const runPreview = async () => {
    const text = json.trim();
    setError(null);
    if (text.length === 0) { setError(t('dashboard.upstreamEditor.codex.import.pasteFirst')); return; }
    setPreviewing(true);
    let data;
    try {
      data = await previewJson(text);
    } catch (err) {
      setPreviewing(false); setError(errorMessage(err)); return;
    }
    setPreviewing(false);
    // The operator kept typing while the request was in flight, so this answer
    // describes a document that is no longer on screen.
    if (json.trim() !== text) return;
    setPreviewedJson(text);
    setCandidates(data.candidates);
    const usable = data.candidates.filter(candidate => candidate.issues.length === 0);
    setSelected(usable.length === 1 ? usable[0].sourceIndex : null);
    if (usable.length === 0) setError(t('dashboard.upstreamEditor.codex.import.noValidAccounts'));
  };

  const buildSource = (): Record<string, unknown> => {
    if (tab === 'json') {
      const text = json.trim();
      if (text.length === 0) throw new Error(t('dashboard.upstreamEditor.codex.import.pasteFirst'));
      if (previewedJson !== text) throw new Error(t('dashboard.upstreamEditor.codex.import.previewFirst'));
      const candidate = candidates.find(entry => entry.sourceIndex === selected);
      if (!candidate || candidate.issues.length > 0) throw new Error(t('dashboard.upstreamEditor.codex.import.selectAccount'));
      return { json: { raw_json: text, source_index: candidate.sourceIndex } };
    }
    const accessToken = manual.accessToken.trim();
    if (accessToken.length === 0) throw new Error(t('dashboard.upstreamEditor.codex.import.accessTokenRequired'));
    return {
      manual: {
        access_token: accessToken,
        refresh_token: trimmed(manual.refreshToken),
        id_token: trimmed(manual.idToken),
        account_id: trimmed(manual.accountId),
        email: trimmed(manual.email),
        plan_type: trimmed(manual.planType),
        expires_at: trimmed(manual.expiresAt),
      },
    };
  };

  const submit = async () => {
    setBusy(true); setError(null);
    let source;
    try {
      source = buildSource();
    } catch (err) {
      setBusy(false); setError(errorMessage(err)); return;
    }
    const result = await callApi(() => api.api.upstreams.codex.import.exchange.$post({
      json: { record: previewRecord(record, values), ...source } as never,
    }));
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    onImported(result.data.patch);
    setJson(''); setManual(EMPTY_MANUAL);
    setPreviewedJson(null); setCandidates([]); setSelected(null);
  };

  const candidateExpiry = (candidate: PreviewCandidate): string => candidate.expiresAt === null
    ? t('dashboard.upstreamEditor.codex.expiryUnknown')
    : t('dashboard.upstreamEditor.codex.expires', { time: dateTime(new Date(candidate.expiresAt).toISOString(), locale) });

  return <>
    <TabList aria-label={t('dashboard.upstreamEditor.oauth.importMethod')} selectedValue={tab} onTabSelect={(_, data) => { setTab(String(data.value)); setError(null); }}>
      <Tab value="json">{t('dashboard.upstreamEditor.codex.import.tabJson')}</Tab>
      <Tab value="oauth">{t('dashboard.upstreamEditor.codex.import.tabOAuth')}</Tab>
      <Tab value="manual">{t('dashboard.upstreamEditor.codex.import.tabManual')}</Tab>
    </TabList>

    {tab === 'json' && <div className="grid gap-3">
      <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.codex.import.jsonHint')}</Text>
      <OutcomeMessageBar intent="warning">{t('dashboard.upstreamEditor.codex.import.jsonWarning')}</OutcomeMessageBar>
      <Field label={t('dashboard.upstreamEditor.oauth.credentialJson')}>
        <Textarea className="font-mono" rows={8} value={json} onChange={(_, data) => editJson(data.value)} />
      </Field>
      <div>
        <Button
          disabledFocusable={previewing}
          icon={previewing ? <Spinner size="tiny" /> : <ScanTypeRegular />}
          onClick={() => void runPreview()}
        >
          {t('dashboard.upstreamEditor.codex.import.preview')}
        </Button>
      </div>
      {candidates.length > 0 && <Field label={t('dashboard.upstreamEditor.codex.import.candidates')}>
        <RadioGroup value={selected === null ? '' : String(selected)} onChange={(_, data) => setSelected(Number(data.value))}>
          {candidates.map(candidate => <Radio
            disabled={candidate.issues.length > 0}
            key={candidate.sourceIndex}
            value={String(candidate.sourceIndex)}
            label={<div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Text weight="semibold">
                  {candidate.name ?? candidate.email ?? t('dashboard.upstreamEditor.codex.import.accountFallback', { index: candidate.sourceIndex + 1 })}
                </Text>
                <StatusBadge tone={candidate.renewable ? 'success' : 'warning'}>
                  {t(candidate.renewable ? 'dashboard.upstreamEditor.codex.renewable' : 'dashboard.upstreamEditor.codex.accessOnly')}
                </StatusBadge>
              </div>
              <Text size={200} className="text-fui-fg3 font-mono mono-size-xs">
                {candidate.chatgptAccountId ?? t('dashboard.upstreamEditor.codex.unknownAccountId')}
              </Text>
              <Text size={200} className="text-fui-fg3">
                {`${candidate.planType ?? t('dashboard.upstreamEditor.codex.unknownPlan')} · ${candidateExpiry(candidate)}`}
              </Text>
              {candidate.issues.map(issue => <Text key={issue} size={200} className="text-fui-danger-fg">{issue}</Text>)}
            </div>}
          />)}
        </RadioGroup>
      </Field>}
    </div>}

    {tab === 'oauth' && <OAuthCallbackImport
      kind="codex"
      flowKind="oauth"
      hasAccount={hasAccount}
      record={record}
      getValues={getValues}
      onImported={patch => {
        onImported(patch);
        setJson(''); setManual(EMPTY_MANUAL); setPreviewedJson(null); setCandidates([]); setSelected(null);
      }}
    />}

    {tab === 'manual' && <div className="grid gap-3">
      <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.codex.import.manualHint')}</Text>
      <Field label={t('dashboard.upstreamEditor.codex.import.accessToken')} required>
        <SecretInput value={manual.accessToken} onChange={(_, data) => setManual(draft => ({ ...draft, accessToken: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.refreshToken')} hint={t('dashboard.upstreamEditor.codex.import.refreshTokenHint')}>
        <SecretInput value={manual.refreshToken} onChange={(_, data) => setManual(draft => ({ ...draft, refreshToken: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.idToken')}>
        <SecretInput value={manual.idToken} onChange={(_, data) => setManual(draft => ({ ...draft, idToken: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.accountId')}>
        <Input value={manual.accountId} onChange={(_, data) => setManual(draft => ({ ...draft, accountId: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.email')}>
        <Input value={manual.email} onChange={(_, data) => setManual(draft => ({ ...draft, email: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.planType')}>
        <Input value={manual.planType} onChange={(_, data) => setManual(draft => ({ ...draft, planType: data.value }))} />
      </Field>
      <Field label={t('dashboard.upstreamEditor.codex.import.expiresAt')} hint={t('dashboard.upstreamEditor.codex.import.expiresAtHint')}>
        <Input value={manual.expiresAt} onChange={(_, data) => setManual(draft => ({ ...draft, expiresAt: data.value }))} />
      </Field>
    </div>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}

    {tab !== 'oauth' && <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />} onClick={() => void submit()}>
      {hasAccount ? t('dashboard.upstreamEditor.oauth.reimport') : t('dashboard.upstreamEditor.oauth.import')}
    </Button>}
  </>;
}
