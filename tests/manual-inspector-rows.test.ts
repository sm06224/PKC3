/** @vitest-environment node */
/**
 * 🔴 マニュアル「右のペイン(情報)」が、画面の行の名前と字で合っている(#1087)。
 *
 * 直す前は「作成日・更新日」と書いていたが、画面の行の名前は「作成」「更新」。
 * 日付の欄(日付を付ける / 日付を外す)と文字数の読了目安は載っていなかった。
 * ⚠ 期待する字は、画面を描く側(inspector.ts)の原文から引く ── 手で書くと、
 *   画面の字を変えた日に両方が古いまま緑になる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sectionContaining } from './helpers/manual-style';

const manual = readFileSync('docs/manual.md', 'utf8');
const inspector = readFileSync('src/adapter/ui/render/inspector.ts', 'utf8');

function section(): string {
  // 🔑 見出しの名前ではなく**この節にしか無い 1 文**で探す(章立てを組み替えて見出しが変わっても同じ節を拾う)
  // 🔑 小節を含めない(自分の本文だけ)── 隣の小節の字に満たされない範囲で見る
  const s = sectionContaining(manual, '作成・更新は、お使いの端末の日付と時刻', { ownBodyOnly: true });
  expect(s, '前提:節が見つからない').not.toBeNull();
  return s!;
}

describe('マニュアル 右のペイン(情報)の行の名前 (#1087)', () => {
  it('🔴 画面の行の名前(作成 / 更新 / 全体の字数 / 日付)で書いている', () => {
    const body = section();
    for (const name of ['作成', '更新', '全体の字数', '日付']) {
      expect(inspector, `前提:画面に「${name}」の行が無い`).toContain(`row('${name}'`);
      expect(body, `マニュアルに「${name}」が無い`).toContain(name);
    }
    expect(body, '画面に無い呼び名「作成日」が残った').not.toContain('作成日');
  });

  it('🔴 日付の 2 つのボタンと読了の目安を、画面の字のまま言う', () => {
    const body = section();
    for (const label of ['日付を付ける', '日付を外す']) {
      expect(inspector, `前提:画面に「${label}」が無い`).toContain(`'${label}'`);
      expect(body).toContain(label);
    }
    expect(body).toContain('読了 約');
  });
});
