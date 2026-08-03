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
  TextEditStyle20Color,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';

export interface DashboardPage {
  to: string;
  labelKey: string;
  icon: FluentIcon;
  adminOnly?: boolean;
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

// The account page is reached from the drawer's footer, where the row carries
// the signed-in user's name rather than the page's own; everything else that
// names a page -- the selection indicator, the document title -- still needs it
// under its own label.
export const accountPage: DashboardPage = {
  to: '/dashboard/settings',
  labelKey: 'dashboard.nav.settings',
  icon: Person20Color,
};

export const dashboardPages: DashboardPage[] = [...navGroups.flatMap(group => group.items), accountPage];

export const pageLabelKeys = new Map(dashboardPages.map(page => [page.to, page.labelKey]));
