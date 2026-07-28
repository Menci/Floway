import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../fluent';
import { Panel } from './ui/panel';

const { Text } = fluentComponents;

export function AdminOnlyNotice() {
  const { t } = useTranslation();
  return <Panel className="!p-[22px_24px]">
    <div className="grid gap-[10px] max-w-[680px]">
      <Text size={300} weight="semibold" style={{ color: 'light-dark(#0f6cbd, #75b6f7)' }}>
        {t('dashboard.pages.adminOnly')}
      </Text>
      <Text size={300} className="text-fui-fg3">
        {t('dashboard.pages.adminOnlyDescription')}
      </Text>
    </div>
  </Panel>;
}
