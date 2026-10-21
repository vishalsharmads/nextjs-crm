import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

const colorLiteral = '/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(/';
const paletteClass =
  '/\\b(bg|text|border|ring|fill|stroke|from|to|via|outline|divide|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(-\\d{2,3})?\\b/';
const physicalDirection =
  '/(^|\\s)-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(-|\\s|$)/';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/blueprints/schema.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'modules/*/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // White-label: no hardcoded colors or palette classes, and RTL-safe utilities only.
    files: ['apps/web/src/**/*.{ts,tsx}', 'modules/*/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/theme/defaults.ts', 'apps/web/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${colorLiteral}]`, message: 'Use theme tokens, not color literals.' },
        {
          selector: `TemplateElement[value.raw=${colorLiteral}]`,
          message: 'Use theme tokens, not color literals.',
        },
        {
          selector: `Literal[value=${paletteClass}]`,
          message: 'Use theme token classes (bg-primary, text-ink…).',
        },
        { selector: `TemplateElement[value.raw=${paletteClass}]`, message: 'Use theme token classes.' },
        {
          selector: `:matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) Literal[value=${physicalDirection}]`,
          message: 'Use logical utilities (ms-, me-, ps-, pe-, start-, end-, text-start).',
        },
        {
          selector: `:matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) TemplateElement[value.raw=${physicalDirection}]`,
          message: 'Use logical utilities.',
        },
      ],
    },
  },
  prettier,
);
