import { SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox, Input } from '../ui/fluent-form-controls';

const { Button, Tooltip } = fluentComponents;

export function RequestFilters({ q, failures, onChange }: { q: string; failures: boolean; onChange: (q: string, failures: boolean) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(q);
  const [onlyFailures, setOnlyFailures] = useState(failures);
  return <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); onChange(query.trim(), onlyFailures); }}>
    <Input
      aria-label={t('dashboard.requests.search')}
      placeholder={t('dashboard.requests.search')}
      value={query}
      onChange={(_, data) => setQuery(data.value)}
      contentAfter={<Tooltip content={t('dashboard.requests.applyFilters')} relationship="label">
        <Button appearance="subtle" aria-label={t('dashboard.requests.applyFilters')} icon={<SearchRegular />} size="small" type="submit" />
      </Tooltip>}
    />
    <Checkbox checked={onlyFailures} label={t('dashboard.requests.failuresOnly')} onChange={(_, data) => setOnlyFailures(data.checked === true)} />
  </form>;
}
