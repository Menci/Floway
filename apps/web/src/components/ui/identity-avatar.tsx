import type { AvatarProps, SlotRenderFunction } from '@fluentui/react-components';
import type { ComponentProps, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Avatar } = fluentComponents;

const Initials = ({ children }: { children: ReactNode }) => <span className="floway-avatar-initials">{children}</span>;

const renderInitials: SlotRenderFunction<ComponentProps<'span'>> = (Component, slotProps) =>
  <Component {...slotProps}><Initials>{slotProps.children}</Initials></Component>;

export function IdentityAvatar({ initials, ...props }: Omit<AvatarProps, 'initials'> & { initials?: string }) {
  return <Avatar {...props} initials={{ children: initials === undefined ? renderInitials : <Initials>{initials}</Initials> }} />;
}
