import {
  Chat20Color,
  Clipboard20Color,
  Cloud20Color,
  Database20Color,
  DataPie20Color,
  DismissRegular,
  DocumentText20Color,
  Gauge20Color,
  People20Color,
  Person20Color,
  PersonKey20Color,
  SearchSparkle20Color,
  ShareAndroid20Color,
  ShareIos20Color,
  TextEditStyle20Color,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import type { AuthUser } from '../api/auth';
import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { useAuthStore } from '../stores/auth-store';
import { ConfirmDialog } from './ui/confirm-dialog';
import { ScrollArea } from './ui/scroll-area';

const {
  Button,
  NavDrawer,
  NavDrawerBody,
  NavDrawerFooter,
  NavDrawerHeader,
  NavItem,
  NavSectionHeader,
  makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  item: {
    backgroundColor: 'transparent !important',
    borderRadius: '6px !important',
    gap: '12px !important',
    height: '36px !important',
    minHeight: '36px !important',
    paddingBottom: '8px !important',
    paddingLeft: '12px !important',
    paddingTop: '8px !important',
    position: 'relative',
    '&:hover': { backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 5%, transparent) !important' },
    '&:active': { backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 9%, transparent) !important' },
    '&:hover:active': { backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 13%, transparent) !important' },
    '&[aria-current="page"]': {
      backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 9%, transparent) !important',
    },
    '&[aria-current="page"]:hover': {
      backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 13%, transparent) !important',
    },
    '&[aria-current="page"]:active': {
      backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 13%, transparent) !important',
    },
    '&[aria-current="page"]:hover:active': {
      backgroundColor: 'color-mix(in srgb, var(--colorBrandBackground) 17%, transparent) !important',
    },
    '&[aria-current="page"]::after': {
      backgroundColor: 'var(--colorBrandStroke1) !important',
      borderRadius: '2px',
      bottom: 'auto !important',
      content: '"" !important',
      display: 'block !important',
      height: '20px !important',
      left: '16px !important',
      position: 'absolute',
      right: 'auto !important',
      top: '8px !important',
      width: '3px !important',
      zIndex: 1,
    },
  },
  // ShareIos draws its tray opening upward. Turned a quarter clockwise the
  // arrow leaves to the right, which is the direction a sign-out reads in.
  signOutIcon: {
    transform: 'rotate(90deg)',
  },
});

type NavItemDefinition = {
  to: string;
  labelKey: string;
  icon: FluentIcon;
  adminOnly?: boolean;
};

type NavGroup = {
  labelKey?: string;
  adminOnly?: boolean;
  items: NavItemDefinition[];
};

const navGroups: NavGroup[] = [
  {
    items: [
      { to: '/dashboard/playground', labelKey: 'dashboard.nav.playground', icon: Chat20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.providers',
    items: [
      { to: '/dashboard/providers/upstreams', labelKey: 'dashboard.nav.upstreams', icon: Cloud20Color, adminOnly: true },
      { to: '/dashboard/providers/search', labelKey: 'dashboard.nav.search', icon: SearchSparkle20Color, adminOnly: true },
      { to: '/dashboard/providers/proxy', labelKey: 'dashboard.nav.proxy', icon: ShareAndroid20Color, adminOnly: true },
      { to: '/dashboard/providers/model-aliases', labelKey: 'dashboard.nav.modelAliases', icon: TextEditStyle20Color, adminOnly: true },
    ],
  },
  {
    labelKey: 'dashboard.groups.services',
    items: [
      { to: '/dashboard/services/api-keys', labelKey: 'dashboard.nav.apiKeys', icon: PersonKey20Color },
      { to: '/dashboard/services/api-docs', labelKey: 'dashboard.nav.apiDocs', icon: DocumentText20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.monitor',
    items: [
      { to: '/dashboard/monitor/requests', labelKey: 'dashboard.nav.requests', icon: Clipboard20Color },
      { to: '/dashboard/monitor/usage', labelKey: 'dashboard.nav.usage', icon: DataPie20Color },
      { to: '/dashboard/monitor/performance', labelKey: 'dashboard.nav.performance', icon: Gauge20Color },
    ],
  },
  {
    labelKey: 'dashboard.groups.admin',
    adminOnly: true,
    items: [
      { to: '/dashboard/admin/users', labelKey: 'dashboard.nav.users', icon: People20Color },
      { to: '/dashboard/admin/backup-restore', labelKey: 'dashboard.nav.backupRestore', icon: Database20Color },
    ],
  },
];

export function Sidebar({ onNavigate, user }: { onNavigate?: () => void; user: AuthUser }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const logout = useAuthStore(state => state.logout);
  const styles = useStyles();
  const [logoutOpen, setLogoutOpen] = useState(false);
  // Color icons carry hardcoded gradient ids, so two mounted drawers would
  // collide on them. idPrefix namespaces the ids per Sidebar instance, and the
  // separators React puts around useId() are illegal inside url(#…).
  const iconIdPrefix = useId().replace(/[^a-zA-Z0-9]/g, '');
  const selectedValue = navGroups
    .flatMap(group => group.items)
    .find(item => pathname === item.to || pathname.startsWith(`${item.to}/`))?.to
    ?? (pathname.startsWith('/dashboard/settings') ? '/dashboard/settings' : '');

  return <>
    <NavDrawer
      aria-label={t('dashboard.nav.label')}
      className="!bg-transparent !h-full !max-w-none !w-full"
      density="medium"
      onNavItemSelect={(_, data) => {
        if (data.value === 'logout') {
          setLogoutOpen(true);
          return;
        }
        void navigate(data.value);
        onNavigate?.();
      }}
      open
      selectedValue={selectedValue}
      type="inline"
    >
      <NavDrawerHeader className="!bg-transparent !px-5 !py-4">
        <div className="flex items-center min-h-10">
          <FlowayLogo size="compact" />
          {onNavigate && <Button appearance="subtle" aria-label={t('dashboard.nav.close')} className="!ml-auto" icon={<DismissRegular />} onClick={onNavigate} />}
        </div>
      </NavDrawerHeader>
      <NavDrawerBody className="!bg-transparent !overflow-hidden !p-0">
        <ScrollArea axes="vertical" className="h-full min-h-0" contentClassName="px-[10px]" noTabIndex>
          {navGroups.map((group, groupIndex) => {
            if (group.adminOnly && !user.isAdmin) return null;
            const items = group.items.filter(item => !item.adminOnly || user.isAdmin);
            if (items.length === 0) return null;
            return <div key={group.labelKey ?? groupIndex}>
              {group.labelKey && <NavSectionHeader>{t(group.labelKey)}</NavSectionHeader>}
              <div className="grid gap-1">
                {items.map(item => {
                  const Icon = item.icon;
                  return <NavItem className={styles.item} icon={<Icon idPrefix={iconIdPrefix} />} key={item.to} value={item.to}>{t(item.labelKey)}</NavItem>;
                })}
              </div>
            </div>;
          })}
        </ScrollArea>
      </NavDrawerBody>
      <NavDrawerFooter className="!bg-transparent !border-t !border-t-solid !gap-y-1 !px-[10px] !py-3" style={{ borderTopColor: 'var(--colorNeutralStroke2)' }}>
        <NavItem className={styles.item} icon={<Person20Color idPrefix={iconIdPrefix} />} value="/dashboard/settings">{user.username}</NavItem>
        <NavItem className={styles.item} icon={<ShareIos20Color className={styles.signOutIcon} idPrefix={iconIdPrefix} />} value="logout">{t('dashboard.logout.label')}</NavItem>
      </NavDrawerFooter>
    </NavDrawer>
    <ConfirmDialog
      actionLabel={t('dashboard.logout.action')}
      actionIntent="primary"
      message={t('dashboard.logout.message')}
      onConfirm={() => void logout()}
      onOpenChange={setLogoutOpen}
      open={logoutOpen}
      title={t('dashboard.logout.title')}
    />
  </>;
}
