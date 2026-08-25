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

  it('🔴 見るのは器だけ(埋め込んだ JS の中の文字列に当たらない)', () => {
    // ⚠ ここを外すと、`` `src="${e}"` `` のような組み立てに当たって必ず落ちる
    expect(FOLD, 'script の中身を抜いていない').toContain('<script');
    expect(FOLD, 'style の中身を抜いていない').toContain('<style');
    expect(FOLD, '中身を抜く置換になっていない').toContain("'<script></script>'");
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

describe('⚠ 日本語が壊れない(出るまで気づけない形を作らない)', () => {
  it('🔴 UTF-8 のまま復号する(`atob` だけで済ませない)', () => {
    // ⚠ `atob` はバイト列を文字コードとして読む ── worker の中の日本語の断り文が化ける
    expect(FOLD, 'TextDecoder を通していない').toContain('new TextDecoder().decode');
    expect(FOLD).toContain('Uint8Array');
  });
});
