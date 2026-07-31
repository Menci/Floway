import { DismissRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Tooltip } = fluentComponents;

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
//
// Living inside somebody else's container is why the bar and its body both take
// a class: the container states the spacing around the bar, and a long
// unbreakable token — a URL, a model id — needs the body to say where it may
// wrap. The icon is open for the same reason: intent picks the glyph, but a
// caller reporting something the intent does not name may say so itself.
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
