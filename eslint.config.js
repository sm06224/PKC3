import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/sw.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node で走る運用スクリプト(probe / ベンチ)。ブラウザ評価関数内の window も許す
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        window: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
