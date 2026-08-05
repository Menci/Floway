import UnoCSS from '@unocss/postcss';
import type { Plugin } from 'postcss';
import valueParser from 'postcss-value-parser';

const fontsourceStylesheet = /\/@fontsource(?:-variable)?\/[^/]+\/[^/]+\.css$/;

const cssUnescape = (value: string): string =>
  value.replaceAll(/\\(?:([\da-f]{1,6})[\t\n\f\r ]?|\r\n|([\s\S]))/gi, (_, hex: string | undefined, escaped: string | undefined) => {
    if (hex !== undefined) {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? '\uFFFD'
        : String.fromCodePoint(codePoint);
    }
    return escaped === '\n' || escaped === '\r' || escaped === '\f' ? '' : (escaped ?? '');
  });

const significant = (nodes: valueParser.Node[]): valueParser.Node[] =>
  nodes.filter(node => node.type !== 'space' && node.type !== 'comment');

const functionArgument = (node: valueParser.FunctionNode): string | undefined => {
  const nodes = significant(node.nodes);
  if (nodes.length !== 1 || (nodes[0]!.type !== 'string' && nodes[0]!.type !== 'word')) return;
  return cssUnescape(nodes[0]!.value);
};

const hasUnclosedNode = (nodes: valueParser.Node[]): boolean =>
  nodes.some(
    node => ('unclosed' in node && node.unclosed === true)
      || (node.type === 'function' && hasUnclosedNode(node.nodes)),
  );

interface WoffReferences {
  format: boolean;
  url: boolean;
}

const woffReferences = (nodes: valueParser.Node[]): WoffReferences => {
  const references: WoffReferences = { format: false, url: false };
  valueParser.walk(nodes, node => {
    if (node.type !== 'function') return;
    const name = cssUnescape(node.value).toLowerCase();
    const argument = functionArgument(node);
    if (argument === undefined) return;
    if (name === 'format' && argument.toLowerCase() === 'woff') references.format = true;
    const pathname = argument.split(/[?#]/, 1)[0]!;
    if (name === 'url' && !argument.toLowerCase().startsWith('data:') && /\.woff$/i.test(pathname)) {
      references.url = true;
    }
  });
  return references;
};

const isWoffSource = (nodes: valueParser.Node[]): boolean => {
  const references = woffReferences(nodes);
  return references.format || references.url;
};

interface FontSource {
  delimiterBefore?: valueParser.DivNode;
  nodes: valueParser.Node[];
}

const splitSources = (nodes: valueParser.Node[]): FontSource[] => {
  const sources: FontSource[] = [{ nodes: [] }];
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') {
      sources.push({ delimiterBefore: node, nodes: [] });
    } else {
      sources.at(-1)!.nodes.push(node);
    }
  }
  return sources;
};

const stripWoffSources = (value: string, source: string): string => {
  const parsed = valueParser(value);
  if (hasUnclosedNode(parsed.nodes)) throw new Error(`${source} contains an unclosed font source`);
  const sources = splitSources(parsed.nodes);
  if (sources.some(({ nodes }) => significant(nodes).length === 0)) {
    throw new Error(`${source} contains an empty font source`);
  }

  const retained = sources.filter(({ nodes }) => !isWoffSource(nodes));
  if (retained.length === 0) throw new Error(`${source} does not declare a non-WOFF font source`);

  parsed.nodes = retained.flatMap(
    ({ delimiterBefore, nodes }, index) => index === 0 ? nodes : [delimiterBefore!, ...nodes],
  );
  return valueParser.stringify(parsed.nodes);
};

// Fontsource writes every static face with a WOFF source behind the WOFF2 one,
// so importing one of its stylesheets pulls a second, larger copy of each face
// into the bundle:
// https://github.com/fontsource/fontsource/blob/e50a906d3026beac81ebc47b5436c9d7c2e3a070/packages/core/src/css/face-rule.ts#L26-L44
// No browser this app is built for can ask for it. `build.target` is left at
// Vite's default `baseline-widely-available`, which at this version resolves to
// chrome111, edge111, firefox114, safari16.4 and ios16.4
// (https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/constants.ts#L90-L96),
// while WOFF2 has been answered since Chrome 36, Firefox 39, Safari 10 and iOS
// 10 (https://caniuse.com/woff2).
//
// Removing the source in the existing PostCSS pass leaves the family, weights,
// subset, style and `font-display` upstream's to state. Parsing both the rule
// and its `src` value means whitespace, quoting, escapes, and embedded data-URL
// commas remain CSS syntax rather than assumptions in a text substitution.
export const fontsourceWoff2Only = (): Plugin => ({
  postcssPlugin: 'fontsource-woff2-only',
  Once(root, { result }) {
    const path = result.opts.from?.replaceAll('\\', '/').split(/[?#]/, 1)[0];
    if (path === undefined || !fontsourceStylesheet.test(path)) return;
    root.walkDecls(declaration => {
      if (cssUnescape(declaration.prop).toLowerCase() !== 'src') return;
      declaration.value = stripWoffSources(declaration.value, path);
    });
    root.walkDecls(declaration => {
      const references = woffReferences(valueParser(declaration.value).nodes);
      const src = cssUnescape(declaration.prop).toLowerCase() === 'src';
      if (references.url || (src && references.format)) {
        throw new Error(`${path} still declares a WOFF source`);
      }
    });
  },
});

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
export default { plugins: [fontsourceWoff2Only(), UnoCSS({ cwd: import.meta.dirname })] };
