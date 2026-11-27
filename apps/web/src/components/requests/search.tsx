import { SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Input } from '../ui/fluent-form-controls';

const { Button, Tooltip } = fluentComponents;

// `beside` sits on the search field's row. The placeholder stays short,
// since a placeholder clips rather than wraps; what the search matches is the
// field's name and its tooltip.
export function RequestSearch({ beside, q, onSearch }: {
  beside?: ReactNode | undefined;
  q: string;
  onSearch: (q: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(q);
  return <form className="flex items-center gap-2 min-w-0" onSubmit={event => { event.preventDefault(); onSearch(query.trim()); }}>
    <Tooltip content={t('requests.search')} relationship="description">
      <Input
        className="flex-1 min-w-0"
        aria-label={t('requests.search')}
        placeholder={t('requests.searchShort')}
        value={query}
        onChange={(_, data) => setQuery(data.value)}
        contentAfter={<Tooltip content={t('requests.applyFilters')} relationship="label">
          <Button appearance="subtle" aria-label={t('requests.applyFilters')} icon={<SearchRegular />} size="small" type="submit" />
        </Tooltip>}
      />
    </Tooltip>{beside}
  </form>;
}
