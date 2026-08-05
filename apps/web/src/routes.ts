import { type RouteConfig, index, route } from '@react-router/dev/routes';

// The gallery renders every Fluent control the dashboard uses so the WinUI
// layer can be judged in one place. It is scaffolding, not a product surface:
// no navigation entry, no translations, and its copy is English placeholder
// text. This table is its only importer, so gating it here is what keeps the
// module out of a shipped bundle rather than merely out of the menu.
//
// MODE and not DEV: this file is not part of the bundle Vite is building. It
// runs inside the nested server @react-router/dev spins up to resolve the route
// table, which is created with the outer command's mode but inherits the
// loader process's NODE_ENV. Vite sets MODE from the mode it was given and
// derives DEV and PROD from NODE_ENV alone, so DEV here reports the ambient
// environment while MODE reports the build. Reading DEV was wrong in both
// directions: it dropped the route from react-router dev, and it restored the
// route to a production build whenever NODE_ENV said development.
// https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/config.ts#L2007-L2013
const developmentRoutes =
  import.meta.env.MODE === 'development'
    ? [route('winui-gallery', 'routes/dashboard-winui-gallery.tsx')]
    : [];

export default [
  index('routes/home.tsx'),
  route('dashboard', 'routes/dashboard.tsx', [
    index('routes/dashboard-index.tsx'),
    route('playground', 'routes/dashboard-playground.tsx'),
    route('providers/upstreams', 'routes/dashboard-providers-upstreams.tsx'),
    route('providers/upstreams/new/:provider', 'routes/dashboard-providers-upstreams-new.tsx'),
    route('providers/upstreams/:id', 'routes/dashboard-providers-upstreams-edit.tsx'),
    route('providers/search', 'routes/dashboard-providers-search.tsx'),
    route('providers/proxy', 'routes/dashboard-providers-proxy.tsx'),
    route('providers/model-aliases', 'routes/dashboard-providers-model-aliases.tsx'),
    route('services/api-keys', 'routes/dashboard-services-api-keys.tsx'),
    route('services/api-docs', 'routes/dashboard-services-api-docs.tsx'),
    route('monitor/requests', 'routes/dashboard-monitor-requests.tsx'),
    route('monitor/usage', 'routes/dashboard-monitor-usage.tsx'),
    route('monitor/performance', 'routes/dashboard-monitor-performance.tsx'),
    route('admin/users', 'routes/dashboard-admin-users.tsx'),
    route('admin/backup-restore', 'routes/dashboard-admin-backup-restore.tsx'),
    route('settings', 'routes/dashboard-settings.tsx'),
    ...developmentRoutes,
  ]),
] satisfies RouteConfig;
