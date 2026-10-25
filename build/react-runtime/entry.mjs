// sandbox の箱の中で動く React のランタイム(#528 ②)。`build/react-runtime-plugin.ts` が IIFE の 1 本に畳み、
// 箱の srcdoc へ inline で入れる。外部 CDN は使わない。
//
// 箱の台本(`src/adapter/platform/render/react-frame-doc.ts`)が使う口だけをグローバルに出す:
//   - React / ReactDOM(createRoot)   ── コンポーネントを描く
//   - transform(sucrase)             ── JSX を JavaScript に直す(型は剥がさない = JSX だけ)
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { transform } from 'sucrase';

globalThis.PkcReact = { React, createRoot, transform };
