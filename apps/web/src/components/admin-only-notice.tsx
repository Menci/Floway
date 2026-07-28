import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../fluent';
const { MessageBar, MessageBarBody, MessageBarTitle } = fluentComponents;

export function AdminOnlyNotice() {
  const { t } = useTranslation();
  return <MessageBar intent="info" layout="multiline">
    <MessageBarBody>
      <MessageBarTitle>{t('dashboard.pages.adminOnly')}</MessageBarTitle>
      {t('dashboard.pages.adminOnlyDescription')}
    </MessageBarBody>
  </MessageBar>;
}
