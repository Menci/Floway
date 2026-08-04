import { DismissRegular } from '@fluentui/react-icons';
import { Children, type ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Tooltip } = fluentComponents;

// WinUI lays an InfoBar's text out vertically as soon as one of its parts is
// taller than InfoBarMinHeight, which is the case a body of several messages is
// always in; Fluent's own reflow watches inline overflow alone and so never
// reaches its multiline layout here. This marker is what the vertical-orientation
// geometry in `winui/controls/message-bar.css.ts` is addressed by, and it appears
// only from the second message on, matching the panel's own arrange.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBarPanel.cpp#L69
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBarPanel.cpp#L107-L111
const MessageBarLines = ({ children }: { children: ReactNode }) => {
  const lines = Children.toArray(children);

  return lines.length > 1 ? <div data-winui-message-lines="">{lines}</div> : lines;
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
        <MessageBarLines>{children}</MessageBarLines>
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
