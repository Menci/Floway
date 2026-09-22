import { useState } from 'react';

import { downloadRecords } from './export';
import { api, callApi } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

const { Button } = fluentComponents;

export function BatchExport({ keyId, selected, loadedIds, onChange }: { keyId: string; selected: Set<string>; loadedIds: string[]; onChange: (ids: Set<string>) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = async (separate: boolean) => {
    setBusy(true);
    setError(false);
    try {
      const records: DumpRecord[] = [];
      for (const recordId of selected) {
        const result = await callApi(() => api.api.dump.keys[':keyId'].records[':recordId'].$get({ param: { keyId, recordId } }));
        if (result.error) throw result.error;
        records.push(result.data);
      }
      downloadRecords(records, separate);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return <div className="flex flex-col gap-2">
    <Checkbox checked={loadedIds.length > 0 && loadedIds.every(id => selected.has(id))} label={t('dashboard.requests.selectLoaded')} disabled={busy || loadedIds.length === 0} onChange={(_, data) => onChange(data.checked ? new Set([...selected, ...loadedIds]) : new Set())} />
    {selected.size > 0 && <>
      <span>{busy ? t('dashboard.requests.exporting') : t('dashboard.requests.exportSelection', { count: String(selected.size) })}</span>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} size="small" onClick={() => void run(false)}>{t('dashboard.requests.exportCombined')}</Button>
        <Button disabled={busy} size="small" onClick={() => void run(true)}>{t('dashboard.requests.exportSeparate')}</Button>
        <Button disabled={busy} size="small" onClick={() => onChange(new Set())}>{t('dashboard.requests.clearSelection')}</Button>
      </div>
    </>}
    {error && <OutcomeMessageBar onDismiss={() => setError(false)}>{t('dashboard.requests.exportFailed')}</OutcomeMessageBar>}
  </div>;
}
