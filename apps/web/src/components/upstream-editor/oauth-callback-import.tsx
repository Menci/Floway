import { CheckmarkCircleRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { previewRecord } from './data';
import { clearPkce, generatePkce, parseCallbackPaste, recallPkce, stashPkce } from './pkce';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import { Textarea } from '../ui/fluent-form-controls';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';

const { Button, Field, Link, Spinner, Text } = fluentComponents;

// The codex OAuth tab opens with a hint the claude-code OAuth and Setup-Token
// tabs never carried; the kind prop decides which copy this shared surface
// shows.
export function OAuthCallbackImport({ kind, flowKind, hasAccount, record, getValues, onImported }: {
  kind: 'codex' | 'claude-code';
  flowKind: 'oauth' | 'setup-token';
  hasAccount: boolean;
  record: UpstreamRecord;
  getValues: () => UpstreamEditorValues;
  onImported: (patch: { config?: unknown; state?: unknown }) => void;
}) {
  const { t } = useTranslation();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const [callback, setCallback] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two authorize-url requests can be outstanding at once — a tab switch
  // supersedes one, and the effect below re-fires on every `record` identity
  // change. The generation is taken before the stash as well as before the URL,
  // because a round trip separates them and an older call could otherwise stash
  // last, leaving a verifier that does not belong to the URL that was opened.
  const generation = useRef(0);
  const prepare = useCallback(async () => {
    const mine = ++generation.current;
    setBusy(true); setError(null);
    const pkce = await generatePkce();
    if (generation.current !== mine) return;
    stashPkce(kind, flowKind, { verifier: pkce.verifier, state: pkce.state });
    const body = { record: previewRecord(record, getValues()), challenge: pkce.challenge, state: pkce.state };
    const result = kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.oauth['authorize-url'].$post({ json: body }))
      : flowKind === 'setup-token'
        ? await callApi(() => api.api.upstreams['claude-code']['setup-token']['authorize-url'].$post({ json: body }))
        : await callApi(() => api.api.upstreams['claude-code'].oauth['authorize-url'].$post({ json: body }));
    if (generation.current !== mine) return;
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setAuthorizeUrl(result.data.authorize_url);
  }, [flowKind, getValues, kind, record]);
  // The claude-code OAuth and Setup-Token tabs share this mount, so switching
  // between them must not leave the previous kind's authorize URL behind — the
  // URL and the stashed verifier have to come from the same run.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Clearing the superseded URL is the reset that lets the next prepare run start clean.
  useEffect(() => { setAuthorizeUrl(null); }, [flowKind]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Opening the tab starts an authorize-url request; the pending flag is the start of that work.
  useEffect(() => { if (!authorizeUrl) void prepare(); }, [authorizeUrl, prepare]);

  const submit = async () => {
    setBusy(true); setError(null);
    let parsed: { code: string; state: string };
    let recalled: { verifier: string; state: string };
    try {
      parsed = parseCallbackPaste(callback);
      const found = recallPkce(kind, flowKind, parsed.state);
      if (!found) throw new Error(t('dashboard.upstreamEditor.oauth.unrecognized'));
      recalled = found;
    } catch (err) {
      setBusy(false); setError(errorMessage(err)); return;
    }
    const editorRecord = previewRecord(record, values);
    const result = kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.import.exchange.$post({
          json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier } },
        }))
      : flowKind === 'setup-token'
        ? await callApi(() => api.api.upstreams['claude-code']['setup-token'].exchange.$post({
            json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier, state: parsed.state } },
          }))
        : await callApi(() => api.api.upstreams['claude-code'].oauth.exchange.$post({
            json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier, state: parsed.state } },
          }));
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    clearPkce(kind, flowKind);
    setCallback(''); setAuthorizeUrl(null);
    onImported(result.data.patch);
  };

  return <div className="grid gap-3">
    {kind === 'codex' && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.codex.import.oauthHint')}</Text>}
    {busy && !authorizeUrl
      ? <Spinner label={t('dashboard.upstreamEditor.oauth.preparing')} />
      : authorizeUrl && <div className="flex items-center gap-2 min-w-0">
        <Link href={authorizeUrl} target="_blank" rel="noopener noreferrer"><OpenLinkLabel>{t('dashboard.upstreamEditor.oauth.openAuthorize')}</OpenLinkLabel></Link>
        <TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('dashboard.upstreamEditor.oauth.copy'))} onClick={() => copy(authorizeUrl)} />
      </div>}
    <Field label={t('dashboard.upstreamEditor.oauth.callback')}>
      <Textarea className="font-mono" rows={3} value={callback} onChange={(_, data) => setCallback(data.value)} />
    </Field>
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />} onClick={() => void submit()}>
      {hasAccount ? t('dashboard.upstreamEditor.oauth.reimport') : t('dashboard.upstreamEditor.oauth.import')}
    </Button>
  </div>;
}
