import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import stylisticPlugin from '@stylistic/eslint-plugin';
import vuePlugin from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

import type { Linter } from 'eslint';

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
      patterns: [{
        group: ['@floway-dev/*/src/**'],
        message: 'Cross-package deep imports are forbidden. Use the package\'s public exports map.',
      }],
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
        project: ['./apps/api/tsconfig.json', './apps/web/tsconfig.json', './packages/protocols/tsconfig.json', './packages/translate/tsconfig.json', './packages/ui/tsconfig.json'],
        noWarnOnMultipleProjects: true,
      },
    },
  },
};

const parserOptions: Linter.ParserOptions = {
  parser: tsParser,
  ecmaVersion: 'latest',
  sourceType: 'module',
  project: ['./apps/api/tsconfig.json', './apps/web/tsconfig.json', './packages/protocols/tsconfig.json', './packages/translate/tsconfig.json', './packages/ui/tsconfig.json'],
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
      // Block-order keeps SFCs predictable; everything else flows through commonConfig.
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
      'vue/multi-word-component-names': 'off',
      'vue/no-mutating-props': 'error',
      'vue/require-explicit-emits': 'error',
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
    ],
  },
];

export default config;
