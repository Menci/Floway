import type { Config } from '@react-router/dev/config';

export default {
  // No runtime server rendering. The root route is still prerendered at build
  // time into index.html, which is what puts the boot screen on screen before
  // the bundle parses.
  ssr: false,
  // Keep each lazy route self-contained instead of emitting separate chunks for
  // its component, client loader, and client action exports.
  splitRouteModules: false,
  appDirectory: 'src',
  // Client output lands in dist/client, which wrangler's assets.directory and
  // the Docker web stage both read.
  buildDirectory: 'dist',
} satisfies Config;
