// ESLint 扁平配置。分层约束在这里落地——架构意图写在 README 里活不过三次提交。
import { defineConfig } from 'eslint/config';

// 逐模块枚举——新增模块必补，否则该模块静默变成「谁都可以依赖」（无测试会红）。
const SIBLINGS = ['system', 'doc', 'deps', 'hook-prompt', 'hook-skill', 'annotations'];

const BASE_RULES = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default defineConfig([
  { ignores: ['src/web/public/**', 'node_modules/**', 'assets/**', '.claude/repo/**', '.claude/**'] },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: BASE_RULES,
  },

  // core 是最底层
  {
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['../modules/**', '../runtime/**', '../web/**'], message: 'core 是最底层，不得依赖 modules / runtime / web。' },
      ]}],
    },
  },

  // 模块之间不得互相依赖
  {
    files: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: SIBLINGS.map((s) => `../${s}/*`), message: '模块之间不得互相依赖；共享逻辑下沉 core/。' },
      ]}],
    },
  },

  // system 是刻意的聚合模块例外
  {
    files: ['src/modules/system/**/*.js'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // 前端不能引 Node 侧代码（防止 vite 把 node: 内置模块打进浏览器包）
  {
    files: ['src/web/frontend/**/*.{js,jsx}', 'src/modules/**/view.jsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: '前端不能引用 Node 内置模块。' },
        { group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/runtime/**', '**/core/**'],
          message: '前端只能 import 模块的 view.jsx + web/frontend 下的组件与 api 客户端。' },
      ]}],
    },
  },
]);