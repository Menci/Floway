import { useState } from 'react';

import { downloadRecords } from './export';
import { api, callApi } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import type { DumpRecord } from '@floway-dev/gateway/browser';

const { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } = fluentComponents;

export function BatchExport({ selected, loadedIds, onChange }: { selected: Set<string>; loadedIds: string[]; onChange: (ids: Set<string>) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = async (separate: boolean) => {
    setBusy(true);
    setError(false);
    try {
      const records: DumpRecord[] = [];
      // A selection can span keys, so each record is read by id from the
      // owner-wide endpoint rather than through the key whose page opened it.
      for (const recordId of selected) {
        const result = await callApi(() => api.api.dump.records[':recordId'].$get({ param: { recordId } }));
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
    <div className="flex flex-wrap items-center gap-2">
      <Checkbox checked={loadedIds.length > 0 && loadedIds.every(id => selected.has(id))} label={t('requests.selectLoaded')} disabled={busy || loadedIds.length === 0} onChange={(_, data) => onChange(data.checked ? new Set([...selected, ...loadedIds]) : new Set([...selected].filter(id => !loadedIds.includes(id))))} />
      {selected.size > 0 && <Menu>
        <MenuTrigger disableButtonEnhancement><Button disabled={busy} size="small" className="!ml-auto">
          {busy ? t('requests.exporting') : t('requests.exportSelection', { count: String(selected.size) })}
        </Button></MenuTrigger>
        <MenuPopover><MenuList>
          <MenuItem onClick={() => void run(false)}>{t('requests.exportCombined')}</MenuItem>
          <MenuItem onClick={() => void run(true)}>{t('requests.exportSeparate')}</MenuItem>
          <MenuItem onClick={() => onChange(new Set())}>{t('requests.clearSelection')}</MenuItem>
        </MenuList></MenuPopover>
      </Menu>}
    </div>
    {error && <OutcomeMessageBar onDismiss={() => setError(false)}>{t('requests.exportFailed')}</OutcomeMessageBar>}
  </div>;
}
