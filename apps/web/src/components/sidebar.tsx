import {
  ArrowRoutingFilled,
  ArrowRoutingRegular,
  ChatFilled,
  ChatRegular,
  ClipboardTextLtrFilled,
  ClipboardTextLtrRegular,
  DatabaseArrowUpFilled,
  DatabaseArrowUpRegular,
  DataUsageFilled,
  DataUsageRegular,
  DismissRegular,
  DocumentTextFilled,
  DocumentTextRegular,
  GaugeFilled,
  GaugeRegular,
  KeyFilled,
  KeyRegular,
  PeopleFilled,
  PeopleRegular,
  PersonFilled,
  PersonRegular,
  PlugConnectedFilled,
  PlugConnectedRegular,
  RenameFilled,
  RenameRegular,
  SearchFilled,
  SearchRegular,
  SignOutRegular,
  bundleIcon,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import type { AuthUser } from '../api/auth';
import { fluentComponents } from '../fluent';
import { FlowayLogo } from './logo';
import { useAuthStore } from '../stores/auth-store';
import { ConfirmDialog } from './ui/confirm-dialog';

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
    position: 'relative',
    '&:hover': { backgroundColor: 'light-dark(rgba(255, 255, 255, 0.48), rgba(255, 255, 255, 0.05)) !important' },
    '&[aria-current="page"]': {
      backgroundColor: 'light-dark(rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.08)) !important',
    },
    '&[aria-current="page"]:hover': {
      backgroundColor: 'light-dark(rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.11)) !important',
    },
    '&[aria-current="page"]::after': {
      backgroundColor: 'var(--colorBrandStroke1) !important',
      borderRadius: '2px',
      bottom: 'auto !important',
      content: '"" !important',
      display: 'block !important',
      height: '20px !important',
      left: '4px !important',
      position: 'absolute !important',
      right: 'auto !important',
      top: '10px !important',
      width: '3px !important',
      zIndex: 1,
    },
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
      { to: '/dashboard/playground', labelKey: 'dashboard.nav.playground', icon: bundleIcon(ChatFilled, ChatRegular) },
    ],
  },
  {
    labelKey: 'dashboard.groups.providers',
    items: [
      { to: '/dashboard/providers/upstreams', labelKey: 'dashboard.nav.upstreams', icon: bundleIcon(PlugConnectedFilled, PlugConnectedRegular), adminOnly: true },
      { to: '/dashboard/providers/search', labelKey: 'dashboard.nav.search', icon: bundleIcon(SearchFilled, SearchRegular), adminOnly: true },
      { to: '/dashboard/providers/proxy', labelKey: 'dashboard.nav.proxy', icon: bundleIcon(ArrowRoutingFilled, ArrowRoutingRegular), adminOnly: true },
      { to: '/dashboard/providers/model-aliases', labelKey: 'dashboard.nav.modelAliases', icon: bundleIcon(RenameFilled, RenameRegular), adminOnly: true },
    ],
  },
  {
    labelKey: 'dashboard.groups.services',
    items: [
      { to: '/dashboard/services/api-keys', labelKey: 'dashboard.nav.apiKeys', icon: bundleIcon(KeyFilled, KeyRegular) },
      { to: '/dashboard/services/api-docs', labelKey: 'dashboard.nav.apiDocs', icon: bundleIcon(DocumentTextFilled, DocumentTextRegular) },
    ],
  },
  {
    labelKey: 'dashboard.groups.monitor',
    items: [
      { to: '/dashboard/monitor/requests', labelKey: 'dashboard.nav.requests', icon: bundleIcon(ClipboardTextLtrFilled, ClipboardTextLtrRegular) },
      { to: '/dashboard/monitor/usage', labelKey: 'dashboard.nav.usage', icon: bundleIcon(DataUsageFilled, DataUsageRegular) },
      { to: '/dashboard/monitor/performance', labelKey: 'dashboard.nav.performance', icon: bundleIcon(GaugeFilled, GaugeRegular) },
    ],
  },
  {
    labelKey: 'dashboard.groups.admin',
    adminOnly: true,
    items: [
      { to: '/dashboard/admin/users', labelKey: 'dashboard.nav.users', icon: bundleIcon(PeopleFilled, PeopleRegular) },
      { to: '/dashboard/admin/backup-restore', labelKey: 'dashboard.nav.backupRestore', icon: bundleIcon(DatabaseArrowUpFilled, DatabaseArrowUpRegular) },
    ],
  },
];

const AccountIcon = bundleIcon(PersonFilled, PersonRegular);

export function Sidebar({ onNavigate, user }: { onNavigate?: () => void; user: AuthUser }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const logout = useAuthStore(state => state.logout);
  const styles = useStyles();
  const [logoutOpen, setLogoutOpen] = useState(false);
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
      <NavDrawerBody className="!bg-transparent">
        {navGroups.map((group, groupIndex) => {
          if (group.adminOnly && !user.isAdmin) return null;
          const items = group.items.filter(item => !item.adminOnly || user.isAdmin);
          if (items.length === 0) return null;
          return <div key={group.labelKey ?? groupIndex}>
            {group.labelKey && <NavSectionHeader>{t(group.labelKey)}</NavSectionHeader>}
            {items.map(item => {
              const Icon = item.icon;
              return <NavItem className={styles.item} icon={<Icon fontSize={20} />} key={item.to} value={item.to}>{t(item.labelKey)}</NavItem>;
            })}
          </div>;
        })}
      </NavDrawerBody>
      <NavDrawerFooter className="!bg-transparent !border-t !border-t-solid !px-[10px] !py-3" style={{ borderTopColor: 'var(--colorNeutralStroke2)' }}>
        <NavItem className={styles.item} icon={<AccountIcon fontSize={20} />} value="/dashboard/settings">{user.username}</NavItem>
        <NavItem className={styles.item} icon={<SignOutRegular fontSize={20} />} value="logout">{t('dashboard.logout.label')}</NavItem>
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
