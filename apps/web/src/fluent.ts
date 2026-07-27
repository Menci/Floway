/**
 * Single import surface for Fluent UI React.
 *
 * `@fluentui/react-components` ships both CJS (`lib-commonjs/index.js`) and
 * ESM (`lib/index.js`). A production build resolves the ESM entry and named
 * imports work directly. Vite's dev-time dependency prebundle does not
 * reliably detect all 1200+ named exports through esbuild, and when it misses
 * them it wraps the whole `module.exports` object behind `default` instead —
 * at which point `import { FluentProvider }` fails with:
 *
 * ```
 * Named export 'FluentProvider' not found. The requested module
 * '@fluentui/react-components' is a CommonJS module...
 * ```
 *
 * Taking the namespace and probing it covers every shape: the named export
 * when esbuild found it, `default` when it wrapped CJS, and
 * `module.exports` for older bundlers.
 *
 * Components destructure what they need — `const { Button, Text } =
 * fluentComponents;` — so no call site repeats this and none of them depend on
 * which module format resolved.
 */
import * as fluentNamespace from '@fluentui/react-components';

type FluentComponents = typeof import('@fluentui/react-components');
type FluentComponentsInterop = Partial<FluentComponents> & {
  default?: Partial<FluentComponents>;
  'module.exports'?: Partial<FluentComponents>;
};

const wrappedNamespace = fluentNamespace as unknown as FluentComponentsInterop;

export const fluentComponents = (
  wrappedNamespace.FluentProvider
    ? wrappedNamespace
    : wrappedNamespace.default ?? wrappedNamespace['module.exports']
) as FluentComponents;
