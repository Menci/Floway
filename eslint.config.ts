import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import stylisticPlugin from '@stylistic/eslint-plugin';
import vuePlugin from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

import type { Linter } from 'eslint';

const projectList = [
  './apps/platform-cloudflare/tsconfig.json',
  './apps/platform-node/tsconfig.json',
  './apps/web/tsconfig.json',
  './packages/agent-setup/tsconfig.json',
  './packages/gateway/tsconfig.json',
  './packages/http/tsconfig.json',
  './packages/interceptor/tsconfig.json',
  './packages/platform/tsconfig.json',
  './packages/protocols/tsconfig.json',
  './packages/provider/tsconfig.json',
  './packages/provider-azure/tsconfig.json',
  './packages/provider-claude-code/tsconfig.json',
  './packages/provider-codex/tsconfig.json',
  './packages/provider-copilot/tsconfig.json',
  './packages/provider-custom/tsconfig.json',
  './packages/provider-ollama/tsconfig.json',
  './packages/proxy/tsconfig.json',
  './packages/test-utils/tsconfig.json',
  './packages/translate/tsconfig.json',
  './packages/ui/tsconfig.json',
];

const commonConfig: Linter.Config = {
  plugins: {
    import: importPlugin,
    '@typescript-eslint': tsPlugin as any,
    stylistic: stylisticPlugin,
  },
  rules: {
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index']],
        'newlines-between': 'always',
        distinctGroup: false,
        alphabetize: {
          order: 'asc',
          caseInsensitive: true,
        },
      },
    ],
    'import/no-duplicates': 'error',

    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['@floway-dev/*/src/**'],
          message: 'Cross-package deep imports are forbidden. Use the package\'s public exports map.',
        },
        {
          group: [
            '@floway-dev/platform-cloudflare',
            '@floway-dev/platform-cloudflare/*',
            '@floway-dev/platform-node',
            '@floway-dev/platform-node/*',
          ],
          message: 'Platform implementations are deployment-target apps, not libraries. They are reachable only from their own entry.ts via relative imports.',
        },
      ],
    }],

    // Belt-and-suspenders for the package-name ban above: relative imports
    // bypass `no-restricted-imports`, so a file inside one platform-target app
    // could still reach into another via `../../platform-X/...`. Forbid that
    // sibling crossing here.
    'import/no-restricted-paths': ['error', {
      zones: [
        { target: './apps/platform-cloudflare', from: './apps/platform-node', message: 'Platform-target apps cannot import each other; share via packages/.' },
        { target: './apps/platform-node', from: './apps/platform-cloudflare', message: 'Platform-target apps cannot import each other; share via packages/.' },
      ],
    }],

    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],
    'prefer-const': 'error',
    'no-var': 'error',
    'no-debugger': 'error',
    'object-shorthand': 'error',
    'prefer-template': 'error',
    eqeqeq: ['error', 'always', { null: 'ignore' }],

    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/return-await': ['error', 'always'],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': ['error'],
    '@typescript-eslint/prefer-as-const': 'error',
    '@typescript-eslint/prefer-for-of': 'error',
    '@typescript-eslint/prefer-includes': 'error',
    '@typescript-eslint/prefer-string-starts-ends-with': 'error',
    '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],

    'stylistic/indent': ['error', 2, {
      offsetTernaryExpressions: true,
    }],
    'stylistic/linebreak-style': ['error', 'unix'],
    'stylistic/semi': ['error', 'always'],
    'stylistic/quotes': ['error', 'single', {
      avoidEscape: true,
      allowTemplateLiterals: 'avoidEscape',
    }],
    'stylistic/comma-dangle': ['error', 'always-multiline'],
    'stylistic/arrow-parens': ['error', 'as-needed'],
    'stylistic/object-curly-spacing': ['error', 'always'],
    'stylistic/array-bracket-spacing': ['error', 'never'],
    'stylistic/space-before-function-paren': ['error', {
      anonymous: 'always',
      named: 'never',
      asyncArrow: 'always',
    }],
    'stylistic/space-in-parens': ['error', 'never'],
    'stylistic/comma-spacing': ['error', { before: false, after: true }],
    'stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
    'stylistic/keyword-spacing': ['error'],
    'stylistic/space-before-blocks': ['error', 'always'],
    'stylistic/space-infix-ops': ['error'],
    'stylistic/no-trailing-spaces': ['error'],
    'stylistic/eol-last': ['error', 'always'],
    'stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
    'stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    'stylistic/object-curly-newline': ['error', {
      ObjectExpression: { multiline: true, consistent: true },
      ObjectPattern: { multiline: true, consistent: true },
      ImportDeclaration: { multiline: true, consistent: true },
      ExportDeclaration: { multiline: true, consistent: true },
    }],
    'stylistic/array-bracket-newline': ['error', 'consistent'],
    'stylistic/function-paren-newline': ['error', 'consistent'],
    'stylistic/member-delimiter-style': ['error', {
      multiline: {
        delimiter: 'semi',
        requireLast: true,
      },
      singleline: {
        delimiter: 'semi',
        requireLast: false,
      },
    }],
    'stylistic/type-annotation-spacing': ['error'],
    'stylistic/jsx-quotes': ['error', 'prefer-double'],
  },
  settings: {
    'import/internal-regex': '^@floway-dev/',
    'import/resolver': {
      typescript: {
        project: projectList,
        noWarnOnMultipleProjects: true,
      },
    },
  },
};

const parserOptions: Linter.ParserOptions = {
  parser: tsParser,
  ecmaVersion: 'latest',
  sourceType: 'module',
  project: projectList,
  noWarnOnMultipleProjects: true,
};

const config: Linter.Config[] = [
  {
    ...commonConfig,
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions,
    },
  },
  {
    ...commonConfig,
    files: ['**/*.vue'],
    plugins: {
      ...commonConfig.plugins,
      vue: vuePlugin,
    },
    languageOptions: {
      parser: vueParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ...parserOptions,
        parser: tsParser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // `{ ...commonConfig, rules: {…} }` shadows the spread `rules` (plain
      // JS object-spread within a single literal), and .vue files match no
      // earlier block carrying the common rules — only the **/*.{ts,tsx}
      // block above does. Re-spread commonConfig.rules so SFCs run
      // import/order, stylistic, and async-safety alongside the four vue
      // rules below.
      ...commonConfig.rules,
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      'vue/multi-word-component-names': 'off',
      'vue/no-mutating-props': 'error',
      'vue/require-explicit-emits': 'error',
    },
  },
  {
    // Redefining a single rule replaces its whole option value (the
    // option array is not deep-merged with the earlier declaration), so
    // the platform-impl patterns from commonConfig's `no-restricted-imports`
    // must be re-listed here alongside the proxy-root ban. Other common
    // rules still apply to apps/web via flat-config's per-rule merge
    // across matching config objects.
    files: ['apps/web/**/*.{ts,tsx,vue}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@floway-dev/*/src/**'],
            message: 'Cross-package deep imports are forbidden. Use the package\'s public exports map.',
          },
          {
            group: [
              '@floway-dev/platform-cloudflare',
              '@floway-dev/platform-cloudflare/*',
              '@floway-dev/platform-node',
              '@floway-dev/platform-node/*',
            ],
            message: 'Platform implementations are deployment-target apps, not libraries. They are reachable only from their own entry.ts via relative imports.',
          },
          {
            // Match the bare specifier only, not the `/url`, `/url-kind`,
            // etc. subpaths the dashboard is allowed to import.
            regex: '^@floway-dev/proxy$',
            message: 'apps/web must reach @floway-dev/proxy only via its /url, /url-kind, /proxy-config, or /constants subpath exports — the root pulls in dialers and userspace TLS.',
          },
        ],
      }],
      // Block runtime `import { ... } from '@floway-dev/gateway[/...]'`
      // — apps/web may only type-import from the gateway package (`import
      // type`). Runtime imports would land gateway's data plane into the
      // SPA bundle. Implemented via `no-restricted-syntax` rather than
      // `@typescript-eslint/no-restricted-imports`'s `allowTypeImports`
      // because the latter requires type-aware linting (it OOMs eslint's
      // default heap on this workspace).
      'no-restricted-syntax': ['error', {
        selector: 'ImportDeclaration[importKind!="type"][source.value=/^@floway-dev\\u002Fgateway($|\\u002F)/]',
        message: 'apps/web may only type-import from @floway-dev/gateway. The SPA bundle must not pull gateway runtime code.',
      }, {
        selector: 'ImportDeclaration[importKind!="type"][source.value=/^@floway-dev\\u002Fagent-setup($|\\u002F)/]',
        message: 'apps/web must not runtime-import @floway-dev/agent-setup. It carries the gateway-side route factories and persistence contract; the dashboard derives its configuration type from the RPC client.',
      }],
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/.wrangler/**',
      '**/.worktrees/**',
      '**/.claude/**',
      // Build output
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      // Workspace-root configs (live outside any package's TS project).
      'eslint.config.ts',
      'vitest.config.ts',
      'packages/*/vitest.config.ts',
      'scripts/**',
      // jiti-run build/test scripts, run outside any package's TS project.
      'packages/agent-setup/scripts/**',
    ],
  },
];

export default config;
