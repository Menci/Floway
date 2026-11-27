import { SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Checkbox, Input } from '../ui/fluent-form-controls';

const { Button, Tooltip } = fluentComponents;

// `beside` sits on the search field's row, and `collapsed` leaves the field
// alone there: the failures switch still applies with the next search.
// `narrow` shortens the placeholder, which clips rather than wraps, to fit a
// phone-width field; the field's name still lists what the search matches.
export function RequestFilters({ beside, collapsed = false, narrow = false, q, failures, onChange }: {
  beside?: ReactNode | undefined;
  collapsed?: boolean | undefined;
  narrow?: boolean | undefined;
  q: string;
  failures: boolean;
  onChange: (q: string, failures: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(q);
  const [onlyFailures, setOnlyFailures] = useState(failures);
  return <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); onChange(query.trim(), onlyFailures); }}>
    <div className="flex items-center gap-2 min-w-0"><Input
      className="flex-1 min-w-0"
      aria-label={t('requests.search')}
      placeholder={t(narrow ? 'requests.searchShort' : 'requests.search')}
      value={query}
      onChange={(_, data) => setQuery(data.value)}
      contentAfter={<Tooltip content={t('requests.applyFilters')} relationship="label">
        <Button appearance="subtle" aria-label={t('requests.applyFilters')} icon={<SearchRegular />} size="small" type="submit" />
      </Tooltip>}
    />{beside}</div>
    {!collapsed && <Checkbox checked={onlyFailures} label={t('requests.failuresOnly')} onChange={(_, data) => setOnlyFailures(data.checked === true)} />}
  </form>;
}
