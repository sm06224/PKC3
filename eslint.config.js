import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
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
        document: 'readonly',
        performance: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        InputEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MessageEvent: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
      },
    },
  },
);
