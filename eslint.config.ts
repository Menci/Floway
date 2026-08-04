import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import stylisticPlugin from '@stylistic/eslint-plugin';

import type { Linter } from 'eslint';

// Every sibling of components/ui that carries domain knowledge. Listing the
// domain component directories individually is deliberate: a bare
// './apps/web/src/components' zone would also forbid components/ui from
// importing itself.
const UI_PRIMITIVE_FORBIDDEN_SOURCES = [
  './apps/web/src/api',
  './apps/web/src/auth',
  './apps/web/src/stores',
  './apps/web/src/routes',
  './apps/web/src/components/api-docs',
  './apps/web/src/components/api-keys',
  './apps/web/src/components/backup-restore',
  './apps/web/src/components/charts',
  './apps/web/src/components/model-alias',
  './apps/web/src/components/models',
  './apps/web/src/components/performance',
  './apps/web/src/components/playground',
  './apps/web/src/components/proxy',
  './apps/web/src/components/requests',
  './apps/web/src/components/upstream-editor',
  './apps/web/src/components/upstreams',
  './apps/web/src/components/usage',
];

const RESTRICTED_IMPORT_PATTERNS = [
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
];

const WEB_RESTRICTED_IMPORT_PATTERNS = [
  ...RESTRICTED_IMPORT_PATTERNS,
  {
    // Match the bare specifier only, not the `/url`, `/url-kind`, etc.
    // subpaths the dashboard is allowed to import.
    regex: '^@floway-dev/proxy$',
    message: 'apps/web must reach @floway-dev/proxy only via its /url, /url-kind, /proxy-config, or /constants subpath exports — the root pulls in dialers and userspace TLS.',
  },
];

const projectList = [
  './tsconfig.scripts.json',
  './apps/platform-cloudflare/tsconfig.json',
  './apps/platform-node/tsconfig.json',
  './apps/web/tsconfig.json',
  './apps/web/tsconfig.scripts.json',
  './packages/agent-setup/tsconfig.json',
  './packages/agent-setup/tsconfig.scripts.json',
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

    'no-restricted-imports': ['error', { patterns: RESTRICTED_IMPORT_PATTERNS }],

    // Belt-and-suspenders for the package-name ban above: relative imports
    // bypass `no-restricted-imports`, so a file inside one platform-target app
    // could still reach into another via `../../platform-X/...`. Forbid that
    // sibling crossing here.
    'import/no-restricted-paths': ['error', {
      zones: [
        { target: './apps/platform-cloudflare', from: './apps/platform-node', message: 'Platform-target apps cannot import each other; share via packages/.' },
        { target: './apps/platform-node', from: './apps/platform-cloudflare', message: 'Platform-target apps cannot import each other; share via packages/.' },
        // components/ui holds generic primitives. `no-restricted-imports` only
        // sees package specifiers, so the relative route into a domain module
        // is closed here instead.
        ...UI_PRIMITIVE_FORBIDDEN_SOURCES.map(from => ({
          target: './apps/web/src/components/ui',
          from,
          message: 'components/ui holds generic primitives. A primitive that knows a Floway domain concept belongs in its own domain directory.',
        })),
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
    // Custom hooks live in plain .ts files, so scoping the React rules to .tsx
    // would leave rules-of-hooks unenforced exactly where it matters most.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        ...parserOptions,
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      'react/jsx-key': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-danger-with-children': 'error',
      // The compiler handles JSX; importing React to use it is not required.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  {
    // Redefining a single rule replaces its whole option value: the option
    // array is not deep-merged with the earlier declaration, so the shared
    // patterns are spread in again alongside the proxy-root ban. Other common
    // rules still apply to apps/web via flat-config's per-rule merge across
    // matching config objects.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'react-i18next',
            message: 'Reach react-i18next through src/i18n/translation.tsx so locale keys and interpolation values remain type-checked.',
          },
        ],
        patterns: WEB_RESTRICTED_IMPORT_PATTERNS,
      }],
      // Block runtime `import { ... } from '@floway-dev/gateway[/...]'`
      // — apps/web may only type-import from the gateway package (`import
      // type`). Runtime imports would land gateway's data plane into the
      // SPA bundle. `@typescript-eslint/no-restricted-imports`'s
      // `allowTypeImports` is the closest built-in, but it also clears the
      // inline `import { type X }` form; the selector holds the whole
      // declaration to `import type`.
      'no-restricted-syntax': ['error', {
        selector: 'ImportDeclaration[importKind!="type"][source.value=/^@floway-dev\\u002Fgateway($|\\u002F)/]',
        message: 'apps/web may only type-import from @floway-dev/gateway. The SPA bundle must not pull gateway runtime code.',
      }, {
        selector: 'ImportDeclaration[importKind!="type"][source.value=/^@floway-dev\\u002Fagent-setup($|\\u002F)/]',
        message: 'apps/web must not runtime-import @floway-dev/agent-setup. It carries the gateway-side route factories and persistence contract; the dashboard derives its configuration type from the RPC client.',
      }, {
        // Griffel injects its sheet after the utility sheet, and `Text`'s root
        // states white-space, overflow and text-overflow while `Link`'s states
        // the latter two as `inherit`, all at one class of specificity, so the
        // utility silently loses.
        selector: 'JSXOpeningElement[name.name=/^(Text|Link)$/] > JSXAttribute[name.name="className"] Literal[value=/(^|\\s)(truncate|text-ellipsis|overflow-hidden|whitespace-(no)?wrap)(\\s|$)/]',
        message: 'This utility is dead on Text and Link: their Griffel roots already state white-space, overflow and text-overflow. Use the component\'s own props — `block truncate wrap={false}` trims — or put the box on the plain element around it.',
      }, {
        // XAML draws a focus visual for every focusable element, so an element
        // this app makes focusable carries the app's rect rather than the user
        // agent's outline. `winui-focus-rect` is where that geometry is stated;
        // rows are exempt because the table and list stylesheets ring them
        // through Fluent's own focus-visible stamp.
        selector: 'JSXOpeningElement:not([name.name=/^(TableRow|ListItem)$/]):has(JSXAttribute[name.name="tabIndex"] > JSXExpressionContainer > Literal[value=0]):not(:has(JSXAttribute[name.name="className"] :matches(Literal[value=/winui-focus-rect/], TemplateElement[value.raw=/winui-focus-rect/])))',
        message: 'An element made focusable needs the WinUI focus rect: add `winui-focus-rect` to its className, or `winui-focus-rect-within` to a host whose focusable element the app does not render itself.',
      }, {
        // A Fluent Card that takes any of these props, or a `focusMode`, or a
        // selection, becomes interactive — and an interactive Card flattens
        // every descendant `Text` to its own foreground through a two-class
        // selector no utility can outrank. So a card's secondary line silently
        // stops being secondary, while a `span` beside it carrying the same
        // utility stays dimmed: two spellings of the same intent, two results.
        //
        // CSS cannot un-set that; any counter-declaration has to name a colour,
        // which flattens to a different one. Undoing it properly means putting
        // Fluent's whole sheet in a lower cascade layer, which is a change to
        // how this app injects every Fluent style — far past what a clickable
        // card is worth. A card that answers the pointer is built as the app's
        // own button surface instead; `SettingsCard` is that shape.
        // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts
        selector: 'JSXOpeningElement[name.name="Card"] > JSXAttribute[name.name=/^(focusMode|selected|onSelectionChange|onClick|onDoubleClick|onMouseUp|onMouseDown|onPointerUp|onPointerDown|onTouchStart|onTouchEnd|onDragStart|onDragEnd)$/]',
        message: 'This prop makes the Card interactive, and an interactive Card repaints every descendant Text to its own foreground — a secondary line stops reading as secondary, and no className can win it back. Build a clickable surface as the app\'s own button (see SettingsCard) instead.',
      }, {
        // `truncate` contributes `text-overflow: ellipsis` and nothing else.
        selector: 'JSXOpeningElement[name.name="Text"]:has(JSXAttribute[name.name="truncate"]):not(:has(JSXAttribute[name.name="wrap"]))',
        message: 'Fluent\'s `truncate` only adds the ellipsis. The single line and the clip come from `wrap={false}`, and the clip needs a block display, so a Text that trims states all three.',
      }],
    },
  },
  {
    files: ['apps/web/src/i18n/index.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'react-i18next',
          allowImportNames: ['initReactI18next'],
          message: 'i18n initialization owns only the React plugin; hooks and components belong to translation.tsx.',
        }],
        patterns: WEB_RESTRICTED_IMPORT_PATTERNS,
      }],
    },
  },
  {
    files: ['apps/web/src/i18n/translation.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'react-i18next',
          allowImportNames: ['Trans', 'useTranslation'],
          message: 'The typed translation boundary owns only Trans and useTranslation.',
        }],
        patterns: WEB_RESTRICTED_IMPORT_PATTERNS,
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
      // react-router typegen output, regenerated by `pnpm run typecheck`.
      '**/.react-router/**',
      '**/build/**',
      '**/coverage/**',
      // Workspace-root configs (live outside any checked TS project).
      'eslint.config.ts',
      'vitest.config.ts',
    ],
  },
];

export default config;
