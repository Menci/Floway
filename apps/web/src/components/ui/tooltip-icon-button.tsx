import type { MouseEvent, ReactElement } from 'react';

import { useDangerActionClasses } from './danger';
import { useRouteAddress } from './route-link';
import { fluentComponents } from '../../fluent';

const { Button, Tooltip, mergeClasses } = fluentComponents;

interface IconButtonProps {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  disabledFocusable?: boolean;
  icon: ReactElement;
  label: string;
}

// `disabled` is for a control made unavailable by something outside itself: it
// emits the HTML attribute, so the control leaves the tab order and focus is
// lost. `disabledFocusable` emits aria-disabled alone, keeping focus and tab
// order while Fluent suppresses the click, and is what a control whose own
// command is in flight takes — the button the operator just pressed must not
// pull focus out from under them. XAML draws the same line with
// FrameworkElement.AllowFocusWhenDisabled.
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.frameworkelement.allowfocuswhendisabled
//
// `to` stands where `onClick` would for the button that opens another page. It
// paints the same, because Fluent's own root slot is already an anchor's, and
// it keeps Enter and Space: Fluent runs an anchor root through react-aria's
// button props, which restore the activation an anchor does not have.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-aria/library/src/button/useARIAButtonProps.ts#L84-L120
export function TooltipIconButton(props: IconButtonProps & (
  | { onClick: (event: MouseEvent<HTMLElement>) => void; to?: never }
  | { onClick?: never; to: string }
)) {
  return props.to === undefined
    ? <IconButton {...props} />
    : <AddressedIconButton {...props} to={props.to} />;
}

function AddressedIconButton({ to, ...props }: IconButtonProps & { to: string }) {
  const address = useRouteAddress(to);
  return <IconButton {...props} {...address} />;
}

function IconButton({ className, danger = false, disabled = false, disabledFocusable = false, href, icon, label, onClick }: IconButtonProps & {
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const dangerClasses = useDangerActionClasses();
  const shared = {
    appearance: 'subtle',
    'aria-label': label,
    className: mergeClasses(danger && dangerClasses.button, className),
    disabled,
    disabledFocusable,
    icon,
    onClick,
    size: 'small',
  } as const;
  return <Tooltip content={label} relationship="label">
    {href === undefined ? <Button {...shared} /> : <Button {...shared} as="a" href={href} />}
  </Tooltip>;
}
