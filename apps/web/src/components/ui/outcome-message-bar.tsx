import { DismissRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Tooltip } = fluentComponents;

// Nothing dismisses this on a timer: it carries a server's own words, which may
// need to be read twice or copied. It belongs inside whatever contains the
// control that failed rather than at page level, where a dialog-borne failure
// would be invisible while the dialog is open — hence a class on both the bar
// (the container states the spacing) and the body (a long unbreakable token
// needs somewhere to say where it may wrap).
export function OutcomeMessageBar({
  action,
  bodyClassName,
  children,
  className,
  icon,
  intent = 'error',
  onDismiss,
  title,
}: {
  action?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  icon?: ReactElement;
  intent?: 'error' | 'warning' | 'success' | 'info';
  onDismiss?: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const dismissLabel = t('common.dismiss');

  return (
    <MessageBar className={className} icon={icon} intent={intent}>
      <MessageBarBody className={bodyClassName}>
        {title && <MessageBarTitle>{title}</MessageBarTitle>}
        {children}
      </MessageBarBody>
      {(action ?? onDismiss) && <MessageBarActions
        containerAction={onDismiss && <Tooltip content={dismissLabel} relationship="label">
          <Button
            appearance="transparent"
            aria-label={dismissLabel}
            icon={<DismissRegular />}
            onClick={onDismiss}
          />
        </Tooltip>}
      >{action}</MessageBarActions>}
    </MessageBar>
  );
}
