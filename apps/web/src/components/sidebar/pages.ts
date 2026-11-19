import {
  Chat20Color,
  Clipboard20Color,
  Cloud20Color,
  Database20Color,
  DataPie20Color,
  DocumentText20Color,
  Gauge20Color,
  People20Color,
  Person20Color,
  PersonKey20Color,
  SearchSparkle20Color,
  ShareAndroid20Color,
  Settings20Color,
  TextEditStyle20Color,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';

export interface DashboardPage {
  to: string;
  labelKey: string;
  icon: FluentIcon;
  adminOnly?: boolean;
  permissions?: boolean;
  upstreams?: boolean;
}

export interface NavGroup {
  labelKey?: string;
  adminOnly?: boolean;
  items: DashboardPage[];
}

// The sidebar carries Fluent's multi-colour glyphs, where WinUI's
// NavigationView draws monochrome ones and moves the icon and the label to the
// same brush in every visual state. These assets hard-code their gradient
// stops and consume no currentColor, so the per-state foreground
// winui/controls/nav.css.ts substitutes reaches the label and stops there: a
// row's glyph holds its colour through hover, press and selection. Swapping the
// set to the monochrome Regular/Filled pair is what would close that, and it is
// a product decision about the sidebar's look rather than a styling one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L460-L491
export const navGroups: NavGroup[] = [
  {
    items: [
      { to: '/dashboard/playground', labelKey: 'playground.title', icon: Chat20Color },
    ],
  },
  {
    labelKey: 'app.navigation.groups.providers',
    items: [
      { to: '/dashboard/providers/upstreams', labelKey: 'upstreams.title', icon: Cloud20Color, upstreams: true },
      { to: '/dashboard/providers/search', labelKey: 'search.title', icon: SearchSparkle20Color, adminOnly: true },
      { to: '/dashboard/providers/proxy', labelKey: 'proxies.title', icon: ShareAndroid20Color, adminOnly: true },
      { to: '/dashboard/providers/model-aliases', labelKey: 'models.aliases.title', icon: TextEditStyle20Color, adminOnly: true },
    ],
  },
  {
    labelKey: 'app.navigation.groups.services',
    items: [
      { to: '/dashboard/services/api-keys', labelKey: 'apiKeys.title', icon: PersonKey20Color },
      { to: '/dashboard/services/api-docs', labelKey: 'apiDocs.title', icon: DocumentText20Color },
    ],
  },
  {
    labelKey: 'app.navigation.groups.monitor',
    items: [
      { to: '/dashboard/monitor/requests', labelKey: 'requests.title', icon: Clipboard20Color },
      { to: '/dashboard/monitor/usage', labelKey: 'monitoring.usage.title', icon: DataPie20Color },
      { to: '/dashboard/monitor/performance', labelKey: 'monitoring.performance.title', icon: Gauge20Color },
    ],
  },
  {
    labelKey: 'app.navigation.groups.admin',
    items: [
      { to: '/dashboard/admin/users', labelKey: 'directory.title', icon: People20Color, adminOnly: true },
      { to: '/dashboard/admin/permissions', labelKey: 'permissions.title', icon: PersonKey20Color, permissions: true },
      { to: '/dashboard/admin/backup-restore', labelKey: 'backupRestore.title', icon: Database20Color, adminOnly: true },
      { to: '/dashboard/admin/site-settings', labelKey: 'settings.site.title', icon: Settings20Color, adminOnly: true },
    ],
  },
];

// The account page is reached from the drawer's footer, where the row carries
// the signed-in user's name rather than the page's own; everything else that
// names a page -- the selection indicator, the document title -- still needs it
// under its own label.
export const accountPage: DashboardPage = {
  to: '/dashboard/settings',
  labelKey: 'settings.account.title',
  icon: Person20Color,
};

export const dashboardPages: DashboardPage[] = [...navGroups.flatMap(group => group.items), accountPage];

export const pageLabelKeys = new Map(dashboardPages.map(page => [page.to, page.labelKey]));
