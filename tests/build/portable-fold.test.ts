/**
 * #400 段①②: **畳む後処理の門**。
 *
 * 🔴 単一化は「**参照が消えて縮む**」方向に壊れる ── size cap だけでは
 *   **0 バイトの HTML** を通してしまう(CLAUDE.md「tripwire は上限だけでなく下限も」)。
 *
 * ⚠ ここが見るのは**畳んだ結果**ではなく、**畳む script が持っている門**である
 *   ── 実際に畳んで起動するかは `tests/smoke/portable-html.smoke.spec.ts`
 *   (`file://` は unit では原理的に届かない)。
 *
 * 🔑 **原文を読む test にした理由**: 焼くのに数秒かかるうえ、ここで確かめたいのは
 *   「門が在るか」であって「今日の生成物が通るか」ではない。⚠ ただし**原文 pin は
 *   弱い**ので、門の**中身**(何を見て落とすか)まで書いてある。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- build script(型定義を持たない .mjs)を実際に走らせて見る
import { bundleTagCount, externalRefs, shellOf } from '../../build/portable/shell-scan.mjs';

const FOLD = readFileSync('build/portable/fold.mjs', 'utf-8');
const CONFIG = readFileSync('build/portable.config.ts', 'utf-8');

describe('畳む前提(ビルド設定)', () => {
  it('🔴 本番の `dist` とは別の出口へ焼く(配り物を単一化しない)', () => {
    expect(CONFIG, '出口が dist-portable でない').toContain("outDir: 'dist-portable'");
  });

  it('🔴 単一チャンクにする(分かれていると畳めない)', () => {
    expect(CONFIG).toContain('inlineDynamicImports: true');
  });

  it('🔴 worker は iife(classic の blob worker に載せるため)', () => {
    expect(CONFIG).toContain("worker: { format: 'iife' }");
  });
});

describe('🔴 下限の門(縮む方向の壊れを止める)', () => {
  it('外部参照が 1 件でも残っていたら落とす', () => {
    expect(FOLD, '外部参照の検査が無い').toContain('外部参照が残っている');
  });

  it('抜きすぎの空振り防止が在る', () => {
    expect(FOLD, '抜きすぎの空振り防止が無い').toContain('検査そのものが空振りしている');
  });

  it('主要な印が落ちていたら落とす', () => {
    expect(FOLD).toContain("'data-pkc-slot=\"root\"'");
    expect(FOLD).toContain("'createObjectURL'");
  });

  it('🔴 wasm は「量」で見る(字面では探せない)', () => {
    // ⚠ wasm の data URL は worker の中に在り、その worker はさらに base64 される
    expect(FOLD, 'wasm の下限が無い').toContain('wasm が入っていない');
  });

  it('小さすぎる HTML を通さない', () => {
    expect(FOLD).toContain('畳んだ HTML が小さすぎる');
  });
});

describe('🔴 当たらなかったら落とす(黙って畳まない)', () => {
  it('worker の作り方に 1 件も当たらなければ落とす', () => {
    expect(FOLD).toContain('worker の作り方に 1 件も当たらなかった');
  });

  it('🔴 storage worker の wasm 解決式に当たらなければ落とす', () => {
    // ⚠ ここが当たらないと、blob worker が `blob:…` から wasm を探して**起動しない**
    expect(FOLD).toContain('storage worker の wasm 解決式に当たらなかった');
  });

  it('⚠ 呼び出し式の外側の `.href` は optional(綴りを決め打たない)', () => {
    expect(FOLD, '綴りを 1 通りに決め打っている').toContain("(?:\\\\.href)?");
  });

  it('畳む対象の file が 1 件に決まらなければ落とす', () => {
    expect(FOLD).toContain('件(1 件でないと畳めない)');
  });

  it('worker が 1 件も見つからなければ落とす', () => {
    expect(FOLD).toContain('worker が 1 件も見つからない');
  });
});

/**
 * 🔴 **器の走査は、原文 pin ではなく走らせて見る**(2026-08-25)。
 *
 * ⚠ この 2 つの壊れ方は、**字面では両方とも「在る」**ので原文 pin では捕まらない:
 * ① 埋め込んだ JS の中の `` `src="..."` `` に当たって必ず落ちる
 * ② 印を `</head>` の前に差したつもりが、**JS の中の `</head>`** に当たる
 *   (実際にアプリを真っ白にした)
 */
describe('🔴 器の走査(実際に走らせる)', () => {
  const app = 'var t=`<a src="x.js" href="y.css"></a></head>`;';
  const folded =
    `<html><head><script type="application/json" data-pkc-bundle>{"id":"pkcb-template"}</script>` +
    `<script type="module">${app}</script><style>a{}</style></head>` +
    `<body><div data-pkc-slot="root"></div></body></html>`;

  it('🔴 埋め込んだ JS の中の `src="..."` を外部参照と数えない', () => {
    expect(externalRefs(shellOf(folded))).toEqual([]);
  });

  it('⚠ 空振り防止 ── 本物の外部参照は数える', () => {
    const bad = folded.replace('<body>', '<body><script src="a.js"></script>');
    expect(externalRefs(shellOf(bad))).toEqual(['src="a.js"']);
    /**
     * `<link href>` も同じ(器に残った css)。
     * ⚠ **差し込む錨に `</head>` を使わない** ── この fixture の JS の中にも
     *   `</head>` が在るので、そちらに当たって**器には 1 件も足されない**
     *   (この test を書いていて実際に踏んだ ── 罠は fixture にも出る)。
     */
    const bad2 = folded.replace('</style></head>', '</style><link rel="stylesheet" href="b.css"></head>');
    expect(externalRefs(shellOf(bad2))).toEqual(['href="b.css"']);
  });

  it('`data:` と `#` は外部ではない', () => {
    const ok = folded.replace('<body>', '<body><img src="data:image/png;base64,AA"><a href="#x">');
    expect(externalRefs(shellOf(ok))).toEqual([]);
  });

  it('🔴 器に在る印は 1 件と数える', () => {
    expect(bundleTagCount(shellOf(folded))).toBe(1);
  });

  it('🔴 JS の中に差し込まれた印は数えない(アプリを真っ白にした形)', () => {
    const inside = folded.replace(
      '<script type="module">',
      '<script type="module">var u=`<script data-pkc-bundle></scr`+`ipt></head>`;',
    );
    // ⚠ 器には**もとの 1 件だけ**。JS の中の 1 件は数えない
    expect(bundleTagCount(shellOf(inside))).toBe(1);
    // 器の印を消したら 0 になる(この数えが空振りでない証拠)
    expect(bundleTagCount(shellOf(inside.replace(' data-pkc-bundle', '')))).toBe(0);
  });

  it('⚠ 器を抜きすぎていない(印の受け口が残る)', () => {
    expect(shellOf(folded)).toContain('data-pkc-slot="root"');
  });
});

describe('⚠ 日本語が壊れない(出るまで気づけない形を作らない)', () => {
  it('🔴 UTF-8 のまま復号する(`atob` だけで済ませない)', () => {
    // ⚠ `atob` はバイト列を文字コードとして読む ── worker の中の日本語の断り文が化ける
    expect(FOLD, 'TextDecoder を通していない').toContain('new TextDecoder().decode');
    expect(FOLD).toContain('Uint8Array');
  });
});
