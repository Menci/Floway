import postcssColorFunctionalNotation from 'postcss-color-functional-notation';
import postcssColorHexAlpha from 'postcss-color-hex-alpha';
import stylelint from 'stylelint';

// Vite documents Chrome 61 as the CSS target that prevents alpha colors from
// being emitted with the unsupported #RGBA notation.
// https://vite.dev/config/build-options.html#build-csstarget
export const legacyCssBuild = {
  cssMinify: 'esbuild',
  cssTarget: 'chrome61',
} as const;

export const legacyCssPostCssPlugins = () => [
  postcssColorHexAlpha(),
  postcssColorFunctionalNotation({ enableProgressiveCustomProperties: false }),
];

const legacyCssConfig = {
  rules: {
    'color-hex-alpha': 'never',
    'color-function-notation': 'legacy',
    'function-disallowed-list': ['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'],
  },
} as const satisfies stylelint.Config;

export const assertLegacyCss = async (fileName: string, css: string): Promise<void> => {
  const result = await stylelint.lint({ code: css, codeFilename: fileName, config: legacyCssConfig });
  if (!result.errored) return;
  const problems = result.results.flatMap(({ invalidOptionWarnings, parseErrors, warnings }) => [
    ...invalidOptionWarnings.map(warning => `${fileName}: ${warning.text}`),
    ...parseErrors.map(error => `${fileName}:${error.line}:${error.column}: ${error.text}`),
    ...warnings.map(warning => `${fileName}:${warning.line}:${warning.column}: ${warning.text}`),
  ]);
  throw new Error(`Unsupported CSS reached the browser boundary:\n${problems.join('\n')}`);
};
