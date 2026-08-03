// Fluent publishes distinct ESM and CommonJS entrypoints, and Vite may expose a
// CommonJS `module.exports` object through `default`.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-components/package.json#L89-L102
// https://github.com/vitejs/vite/blob/5e7fe129a4dde4f41934083b25e490059985f4e6/docs/guide/troubleshooting.md#L290-L300
import * as fluentNamespace from '@fluentui/react-components';

import { withWinuiAppearance } from './winui/appearance';
import { withWinuiMotion } from './winui/presence';
import { withWinuiProgressIndeterminate } from './winui/progress-indeterminate';
import { withWinuiDrag } from './winui/switch-drag';
import { withWinuiToaster } from './winui/toaster';

type FluentComponents = typeof import('@fluentui/react-components');
type FluentComponentsInterop = Partial<FluentComponents> & {
  default?: Partial<FluentComponents>;
  'module.exports'?: Partial<FluentComponents>;
};

const wrappedNamespace = fluentNamespace as unknown as FluentComponentsInterop;

const resolvedNamespace = wrappedNamespace.FluentProvider
  ? wrappedNamespace
  : wrappedNamespace.default ?? wrappedNamespace['module.exports'];

if (!resolvedNamespace?.FluentProvider) {
  throw new Error('Neither interop shape of @fluentui/react-components exposes a component surface.');
}

const normalizedNamespace = resolvedNamespace as FluentComponents;

// The app's only value import of `@fluentui/react-components`, so it is the one
// place the appearance stamping, motion substitution, toaster replacement and
// Switch drag gesture reach every instance. `react-components` re-exports only
// the toast's component layer, so the state and hook layers the toaster is
// rebuilt from are imported from `@fluentui/react-toast` in ./winui/toaster,
// which is the app's only value import of that package.
export const fluentComponents = withWinuiToaster(withWinuiDrag(
  withWinuiProgressIndeterminate(withWinuiMotion(withWinuiAppearance(normalizedNamespace))),
));
