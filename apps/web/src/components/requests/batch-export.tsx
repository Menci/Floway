import { useState } from 'react';

import { downloadRecords, type ArchiveExport } from './export';
import { api, requestResponse } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';

const { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } = fluentComponents;

export function BatchExport({ keyId, selected, loadedIds, onChange }: { keyId: string; selected: Set<string>; loadedIds: string[]; onChange: (ids: Set<string>) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = async (separate: boolean) => {
    setBusy(true);
    setError(false);
    try {
      const records: ArchiveExport[] = [];
      for (const recordId of selected) {
        const result = await requestResponse(() => api.api.dump.keys[':keyId'].records[':recordId'].archive.$get({ param: { keyId, recordId } }));
        if (result.error) throw result.error;
        records.push({ id: recordId, archive: await result.data.text() });
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
