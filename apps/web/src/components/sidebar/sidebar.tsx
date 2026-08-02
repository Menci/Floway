import type { NavItemProps } from '@fluentui/react-components';
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
import { useId, useRef } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLinkClickHandler, useLocation, useNavigation } from 'react-router';

import type { AuthUser } from '../../api/auth';
import { fluentComponents } from '../../fluent';
import { pageNavigation } from '../../lib/page-navigation';
import { FlowayLogo } from '../logo';
import { NavSelectionIndicator } from './nav-selection-indicator';
import { useAuthStore } from '../../stores/auth-store';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ScrollArea } from '../ui/scroll-area';
import { useDialogInvocation } from '../ui/use-dialog-invocation';

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
  // 36px is a floor rather than a fixed height, so a two-line label lengthens
  // the row instead of being cut. The left-pane template's 40px icon column
  // plus the presenter's 4 puts the label at 44; Fluent's icon slot is 20px
  // wide, so the gap carrying the label to that 44 is 12 rather than 16.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L208
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L219
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L251
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L604-L616
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationViewItemPresenter.cpp#L286-L290
  item: {
    gap: '12px',
    minHeight: '36px',
    paddingBottom: '8px',
    paddingLeft: '12px',
    paddingRight: '14px',
    paddingTop: '8px',
  },
  // ShareIos draws its tray opening upward. Turned a quarter clockwise the
  // arrow leaves to the right, which is the direction a sign-out reads in.
  signOutIcon: {
    transform: 'rotate(90deg)',
  },
});

// WinUI hangs the pill off the leading edge of the presenter's content root
// with no margin of its own.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L600-L603
const NAV_INDICATOR_INSET = 0;

interface NavItemDefinition {
  to: string;
  labelKey: string;
  icon: FluentIcon;
  adminOnly?: boolean;
}

interface NavGroup {
  labelKey?: string;
  adminOnly?: boolean;
  items: NavItemDefinition[];
}

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

function SidebarLink({ children, icon, onNavigate, pending, to }: {
  children: ReactNode;
  icon: NavItemProps['icon'];
  onNavigate?: () => void;
  pending: boolean;
  to: string;
}) {
  const styles = useStyles();
  const handleLinkClick = useLinkClickHandler(to, pageNavigation);
  const handleClick: MouseEventHandler<HTMLAnchorElement> = event => {
    const followsInThisView = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    handleLinkClick(event);
    if (followsInThisView) onNavigate?.();
  };
  return <NavItem
    as="a"
    className={styles.item}
    data-nav-pending={pending || undefined}
    data-nav-value={to}
    href={to}
    icon={icon}
    onClick={handleClick}
    value={to}
  >{children}</NavItem>;
}

export function Sidebar({ onNavigate, user }: { onNavigate?: () => void; user: AuthUser }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const logout = useAuthStore(state => state.logout);
  const styles = useStyles();
  const logoutDialog = useDialogInvocation<void>();
  // Signing out redirects away and unmounts this sidebar, so it waits for the
  // dialog's exit. The exit also runs on a dismissal, so only a confirmed one
  // signs out.
  const signOutConfirmed = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  // Color icons carry hardcoded gradient ids, so two mounted drawers would
  // collide on them; the separators React puts in useId() are illegal inside
  // url(#…).
  const iconIdPrefix = useId().replace(/[^a-zA-Z0-9]/g, '');
  const valueForPath = (path: string) => navGroups
    .flatMap(group => group.items)
    .find(item => path === item.to || path.startsWith(`${item.to}/`))?.to
    ?? (path.startsWith('/dashboard/settings') ? '/dashboard/settings' : '');
  const selectedValue = valueForPath(pathname);
  const pendingValue = navigation.location ? valueForPath(navigation.location.pathname) : '';

  return <>
    <NavDrawer
      aria-label={t('dashboard.nav.label')}
      className="!bg-transparent !h-full !max-w-none !w-full"
      density="medium"
      onNavItemSelect={(_, data) => {
        if (data.value === 'logout') {
          signOutConfirmed.current = false;
          logoutDialog.open();
        }
      }}
      open
      selectedValue={selectedValue}
      surfaceMotion={null}
      type="inline"
    >
      <NavDrawerHeader className="!bg-transparent !px-5 !py-4">
        <div className="flex items-center min-h-10">
          <FlowayLogo />
          {onNavigate && <Button appearance="subtle" aria-label={t('dashboard.nav.close')} className="!ml-auto" icon={<DismissRegular />} onClick={onNavigate} />}
        </div>
      </NavDrawerHeader>
      <NavDrawerBody className="!bg-transparent overflow-hidden !p-0">
        <ScrollArea axes="vertical" className="h-full min-h-0" contentClassName="px-[10px]" noTabIndex>
          <div className="relative" ref={bodyRef}>
            <NavSelectionIndicator containerRef={bodyRef} inset={NAV_INDICATOR_INSET} otherListIs="below" selectedValue={selectedValue} />
            {navGroups.map((group, groupIndex) => {
              if (group.adminOnly && !user.isAdmin) return null;
              const items = group.items.filter(item => !item.adminOnly || user.isAdmin);
              if (items.length === 0) return null;
              return <div key={group.labelKey ?? groupIndex}>
                {group.labelKey && <NavSectionHeader>{t(group.labelKey)}</NavSectionHeader>}
                <div className="grid gap-1">
                  {items.map(item => {
                    const Icon = item.icon;
                    return <SidebarLink
                      icon={<Icon idPrefix={iconIdPrefix} />}
                      key={item.to}
                      onNavigate={onNavigate}
                      pending={pendingValue === item.to}
                      to={item.to}
                    >{t(item.labelKey)}</SidebarLink>;
                  })}
                </div>
              </div>;
            })}
          </div>
        </ScrollArea>
      </NavDrawerBody>
      {/* No rule above these. NavigationView's separator for this seam is
          authored collapsed and revealed only when the menu and the footer
          compete for the pane's height, which is an overflow affordance rather
          than a grouping rule.
          https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L375
          https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1585-L1626 */}
      <NavDrawerFooter className="!bg-transparent !gap-y-1 !px-[10px] !py-3">
        <div className="grid gap-y-1 relative w-full" ref={footerRef}>
          <NavSelectionIndicator containerRef={footerRef} inset={NAV_INDICATOR_INSET} otherListIs="above" selectedValue={selectedValue} />
          <SidebarLink
            icon={<Person20Color idPrefix={iconIdPrefix} />}
            onNavigate={onNavigate}
            pending={pendingValue === '/dashboard/settings'}
            to="/dashboard/settings"
          >{user.username}</SidebarLink>
          <NavItem className={styles.item} icon={<ShareIos20Color className={styles.signOutIcon} idPrefix={iconIdPrefix} />} value="logout">{t('dashboard.logout.label')}</NavItem>
        </div>
      </NavDrawerFooter>
    </NavDrawer>
    {logoutDialog.invocation && <ConfirmDialog
      open={logoutDialog.isOpen}
      actionLabel={t('dashboard.logout.action')}
      actionIntent="primary"
      key={logoutDialog.invocation.key}
      message={t('dashboard.logout.message')}
      onConfirm={() => { signOutConfirmed.current = true; logoutDialog.close(); }}
      onExited={() => { if (signOutConfirmed.current) void logout(); }}
      onOpenChange={open => { if (!open) logoutDialog.close(); }}
      title={t('dashboard.logout.title')}
    />}
  </>;
}
