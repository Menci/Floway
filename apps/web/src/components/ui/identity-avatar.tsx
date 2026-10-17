import type { AvatarProps, SlotRenderFunction } from '@fluentui/react-components';
import type { ComponentProps } from 'react';

import { fluentComponents } from '../../fluent';

const { Avatar } = fluentComponents;

const renderInitials: SlotRenderFunction<ComponentProps<'span'>> = (Component, slotProps) =>
  <Component {...slotProps}><span className="floway-avatar-initials">{slotProps.children}</span></Component>;

export function IdentityAvatar(props: Omit<AvatarProps, 'initials'>) {
  return <Avatar {...props} initials={{ children: renderInitials }} />;
}
