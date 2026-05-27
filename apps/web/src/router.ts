import NProgress from 'nprogress';
import { createRouter, createWebHistory } from 'vue-router';
import { routes } from 'vue-router/auto-routes';

import { useAuthStore } from './stores/auth.ts';

NProgress.configure({ showSpinner: false, trickleSpeed: 120 });

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// The auth guard reads two pieces of route meta: `public: true` skips the
// guard entirely (login + 404), `requiresAdmin: true` redirects API-key users
// away. Everything else just requires being signed in.
router.beforeEach(to => {
  const auth = useAuthStore();
  const isPublic = to.meta.public === true;

  if (!isPublic && !auth.isAuthenticated) return { path: '/login', replace: true };
  if (to.path === '/login' && auth.isAuthenticated) return { path: '/dashboard', replace: true };
  if (to.meta.requiresAdmin === true && !auth.isAdmin) return { path: '/dashboard/keys', replace: true };
  return true;
});

let inFlight = 0;
router.beforeEach((_to, from) => {
  if (from.name === undefined) return;
  if (inFlight === 0) NProgress.start();
  inFlight++;
});

router.afterEach(() => {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) NProgress.done();
});
