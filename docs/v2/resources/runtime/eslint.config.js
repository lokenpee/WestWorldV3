import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const CORE = 'src/core/**/*.{ts,tsx}'
const FEATURES = 'src/features/**/*.{ts,tsx}'
const QUERIES = 'src/queries/**/*.{ts,tsx}'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // scripts/ 与 tests/ 是 Node 环境（有 process / console）
  {
    files: ['scripts/**/*.{js,mjs,ts}', 'tests/**/*.{ts,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ADR-012 第 1、2 条：core 不能依赖 features，不能碰 React / DOM
  {
    files: [CORE],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/features/**', '@/features/**'], message: 'ADR-012: core 不能依赖 features' },
            { group: ['react', 'react-dom', 'react/**', 'react-dom/**'], message: 'ADR-012: core 不能依赖 React' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'ADR-012: core 不能碰 DOM' },
        { name: 'document', message: 'ADR-012: core 不能碰 DOM' },
        { name: 'localStorage', message: 'ADR-012: core 不能碰 DOM' },
        { name: 'sessionStorage', message: 'ADR-012: core 不能碰 DOM' },
      ],
    },
  },

  {
    files: [QUERIES],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/features/**', '@/features/**'], message: 'ADR-012: queries 不能依赖 features' },
          ],
        },
      ],
    },
  },
  // ADR-012 第 3 条：features 不能直接依赖 db / llm
  {
    files: [FEATURES],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/core/db/**', '@/core/llm/**', '**/core/db/**', '**/core/llm/**'],
              message: 'ADR-012: features 不能直接依赖 db / llm，请通过 core 暴露的接口',
            },
          ],
        },
      ],
    },
  },
)


