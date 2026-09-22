import { useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox, Input } from '../ui/fluent-form-controls';

const { Button } = fluentComponents;

export function RequestFilters({ q, failures, onChange }: { q: string; failures: boolean; onChange: (q: string, failures: boolean) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(q);
  const [onlyFailures, setOnlyFailures] = useState(failures);
  return <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); onChange(query.trim(), onlyFailures); }}>
    <Input aria-label={t('dashboard.requests.search')} placeholder={t('dashboard.requests.search')} value={query} onChange={(_, data) => setQuery(data.value)} />
    <div className="flex flex-wrap items-center gap-2">
      <Checkbox checked={onlyFailures} label={t('dashboard.requests.failuresOnly')} onChange={(_, data) => setOnlyFailures(data.checked === true)} />
      <Button className="!ml-auto" size="small" type="submit">{t('dashboard.requests.applyFilters')}</Button>
    </div>
  </form>;
}
