import UnoCSS from '@unocss/postcss';

// UnoCSS generates through PostCSS rather than `unocss/vite`, whose global mode
// emits nothing under React Router: it keys its `vite:css-post` handle by the
// top-level `build.outDir`, while React Router sets `outDir` only per
// environment (`dist/client`, `dist/server`) and opts into
// `builder.sharedConfigBuild`, which is what otherwise re-resolves the config
// per environment. The lookup misses and the layer placeholder ships as the
// entire stylesheet.
// https://github.com/unocss/unocss/issues/4990
// https://github.com/unocss/unocss/blob/e28a47c557fe179935a37a4fbeb650292d0d1d5a/packages-integrations/vite/src/modes/global/build.ts#L128-L182
//
// That plugin's per-module mode does emit, but generates one sheet per module,
// and concatenating them in module-graph order breaks the cascade: a breakpoint
// variant can land ahead of the base utility it has to override, and since a
// media query adds no specificity the base utility wins at every width. Rule
// order is a property of a single `generate()` call, which is what one PostCSS
// pass over the whole content set gives us.
//
// `cwd` resolves both uno.config.ts discovery and the `content.filesystem`
// globs, and defaults to the build process's working directory. Pinning it here
// keeps a build launched from the workspace root scanning the same files as one
// launched from this package.
// https://github.com/unocss/unocss/blob/e28a47c557fe179935a37a4fbeb650292d0d1d5a/packages-integrations/postcss/src/esm.ts#L21-L110
export default { plugins: [UnoCSS({ cwd: import.meta.dirname })] };
