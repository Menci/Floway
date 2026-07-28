// Fluent publishes distinct ESM and CommonJS entrypoints, while Vite may expose
// a CommonJS `module.exports` object through `default`. Normalize that boundary
// once so dev prebundling and production imports share one component surface.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-components/package.json#L89-L102
// https://github.com/vitejs/vite/blob/5e7fe129a4dde4f41934083b25e490059985f4e6/docs/guide/troubleshooting.md#L290-L300
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
