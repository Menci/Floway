// ../vite.config.ts keeps the whole Fluent family out of SSR externalization,
// so every consumer of this module sees the ESM namespace rather than one of
// Fluent's CommonJS entrypoints. The guard is what turns a regression in that
// wiring into a crash here instead of an undefined component deep in a tree.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-components/package.json#L89-L102
import * as fluentNamespace from '@fluentui/react-components';

import { withWinuiAppearance } from './winui/appearance';
import { withWinuiMotion } from './winui/presence';
import { withWinuiDrag } from './winui/switch-drag';
import { withWinuiToaster } from './winui/toaster';
import type { FluentComponents } from './winui/wrap';

if (!(fluentNamespace as Partial<FluentComponents>).FluentProvider) {
  throw new Error('@fluentui/react-components exposes no component surface.');
}

// The app's only value import of `@fluentui/react-components`, so it is the one
// place the appearance stamping, motion substitution, toaster replacement and
// Switch drag gesture reach every instance. `react-components` re-exports only
// the toast's component layer, so the state and hook layers the toaster is
// rebuilt from are imported from `@fluentui/react-toast` in ./winui/toaster,
// which is the app's only value import of that package.
export const fluentComponents = withWinuiToaster(withWinuiDrag(
  withWinuiMotion(withWinuiAppearance(fluentNamespace)),
));
