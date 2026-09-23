import { DismissRegular } from '@fluentui/react-icons';
import { Children, type ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Tooltip } = fluentComponents;

const MessageBarContent = ({ children }: { children: ReactNode }) => {
  const messages = Children.toArray(children);

  return messages.length > 1 ? <div className="winui-message-items">{messages}</div> : messages;
};

// Nothing dismisses this on a timer: it carries a server's own words, which may
// need to be read twice or copied.
export function OutcomeMessageBar({
  action,
  children,
  className,
  intent = 'error',
  onDismiss,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  intent?: 'error' | 'warning' | 'success' | 'info';
  onDismiss?: () => void;
  title?: string;
}) {
  const { t } = useTranslation();
  const dismissLabel = t('common.dismiss');

  return (
    <MessageBar className={className} intent={intent}>
      <MessageBarBody>
        {title && <MessageBarTitle>{title}</MessageBarTitle>}
        <MessageBarContent>{children}</MessageBarContent>
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
