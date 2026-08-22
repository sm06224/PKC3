import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ⚠ `zz*` / `tmp-review-*` は使い捨ての計測 probe(`.gitignore` と同じ綴り)
  // ⚠ `build/office-wasm/pages/coi-serviceworker.js` は **vendor した第三者コード**
  //    (MIT、gzuidhof/coi-serviceworker)。service worker の大域(`self`)を使うので
  //    node として読むと no-undef が 42 件出る。整形も書き換えもしない ── 除外する。
  {
    ignores: ['dist/**', 'node_modules/**', 'tests/**/zz*', 'tests/**/tmp-review-*',
      'build/office-wasm/pages/coi-serviceworker.js'],
  },
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
        clearTimeout: 'readonly',
        BroadcastChannel: 'readonly',
        InputEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MessageEvent: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
        // ⚠ 計器(`tests/bench/*.mjs`)は page.evaluate の中で
        //    ブラウザ側の API を使う ── そちらの global もここに要る
        PerformanceObserver: 'readonly',
        DataTransfer: 'readonly',
        File: 'readonly',
        Event: 'readonly',
        indexedDB: 'readonly',
        Worker: 'readonly',
      },
    },
  },
);
