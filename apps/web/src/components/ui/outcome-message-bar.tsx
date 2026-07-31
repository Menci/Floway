import { DismissRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } = fluentComponents;

// The surface a failure is reported on. It stays until the operator closes it,
// because what it carries is a server's own words: `callApi` never throws, so
// every failure message here is text the operator may need to read twice, copy,
// or keep on screen while trying something else. Nothing dismisses it on a
// timer and no unrelated activity clears it.
//
// It is meant to live inside whatever contains the control that failed — the
// dialog, the panel, the card — rather than at the top of the page. A failure
// announced somewhere other than where it happened is one the operator has to
// go looking for, and a dialog-borne failure announced at page level is one
// they cannot see at all while the dialog is open.
export function OutcomeMessageBar({
  action,
  children,
  intent = 'error',
  onDismiss,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  intent?: 'error' | 'warning' | 'success' | 'info';
  onDismiss?: () => void;
  title?: string;
}) {
  const { t } = useTranslation();

  return (
    <MessageBar intent={intent}>
      <MessageBarBody>
        {title && <MessageBarTitle>{title}</MessageBarTitle>}
        {children}
      </MessageBarBody>
      {(action ?? onDismiss) && <MessageBarActions
        containerAction={onDismiss && <Button
          appearance="transparent"
          aria-label={t('common.dismiss')}
          icon={<DismissRegular />}
          onClick={onDismiss}
        />}
      >{action}</MessageBarActions>}
    </MessageBar>
  );
}
