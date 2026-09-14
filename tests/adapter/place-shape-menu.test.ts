/**
 * 🔴 **板の形を選ぶ動線**(#530 案 A。user 裁定 2026-09-14)。
 *
 * 見るのは 3 つで、**どれか 1 つでも欠けると「押しても何も起きない」になる**:
 *
 * | | 何を |
 * |---|---|
 * | 右クリックの一覧 | 形の項目が並ぶか(⚠ **いまの形は出さない**) |
 * | 受け手(`binder.ts`) | その綴りの受け手が**全部**在るか |
 * | reducer | 押したら本文が書き換わるか / 断るときは声に出すか |
 *
 * ⚠ 3 つは**別の file** なので、1 つの test で「動線が繋がっている」とは言えない ──
 * だから**全数**で突き合わせる(CLAUDE.md §7「合意を見る場所を別に 1 つ作る」)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockMenuActions } from '../../src/features/entry-actions';
import { PLACE_SHAPES, type PlaceShape } from '../../src/features/markdown/place-shape';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';

const OPEN = ':::format{.pkc-place x=10 y=20 w=240 h=120}';
const BODY = `${OPEN}\nメモ\n:::\n`;

describe('右クリックの一覧', () => {
  it('板でなければ形の項目は 1 つも出ない(押しても効かない口を作らない)', () => {
    const acts = blockMenuActions({ board: false }).map((a) => a.action);
    expect(acts.filter((a) => a.startsWith('place-shape-'))).toEqual([]);
  });

  it('🔴 板なら、いまの形**以外**が並ぶ', () => {
    const acts = blockMenuActions({ board: true, shape: 'rect' }).map((a) => a.action);
    expect(acts).toContain('place-shape-diamond');
    // ⚠ いま四角なのに「四角にする」を出さない ── 押しても 1 ドットも変わらない
    expect(acts, '押しても何も起きない項目が出ている').not.toContain('place-shape-rect');
    expect(acts.filter((a) => a.startsWith('place-shape-'))).toHaveLength(PLACE_SHAPES.length - 1);
  });

  it('🔴 形が付いていれば「四角にもどす」側が出る(片道の操作を作らない)', () => {
    const acts = blockMenuActions({ board: true, shape: 'diamond' }).map((a) => a.action);
    expect(acts).toContain('place-shape-rect');
    expect(acts).not.toContain('place-shape-diamond');
  });

  it('⚠ 形を渡さなければ四角として扱う(呼び側が書き忘れても安全な向き)', () => {
    const acts = blockMenuActions({ board: true }).map((a) => a.action);
    expect(acts).not.toContain('place-shape-rect');
  });

  it('⚠ もとから在る項目を押し出していない', () => {
    const acts = blockMenuActions({ board: true, shape: 'rect' }).map((a) => a.action);
    expect(acts[0]).toBe('copy-block-md');
    expect(acts).toContain('raise-place');
    // ⚠ 消すは**いちばん最後**(確認を挟む物を真ん中に置かない)
    expect(acts[acts.length - 1]).toBe('remove-place');
  });

  it('呼び名は見たままの言葉(内部の綴りを画面に出さない)', () => {
    const labels = blockMenuActions({ board: true, shape: 'rect' })
      .filter((a) => a.action.startsWith('place-shape-'))
      .map((a) => a.label);
    expect(labels).toContain('◆ ひし形にする');
    for (const l of labels) expect(l).not.toMatch(/ellipse|diamond|arrow|round/);
  });
});

/**
 * 🔴 **受け手が全部いるか**(#530)。
 *
 * ⚠ `repo-hygiene` の「受け手のいない action」は**画面へ字で書いた物**しか見ない ──
 *   形の項目は右クリックの一覧が組み立てるので、**あちらの網には掛からない**。
 * 🔑 だからここで、綴りの表から**全数**で引く。
 */
describe('受け手(binder.ts)', () => {
  const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
  // ⚠ 注釈を落としてから見る ── 解説に綴りを書くと、受け手が無くても緑になる
  const code = binder.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 形の数だけ受け手が在る', () => {
    expect(PLACE_SHAPES.length, '形が 1 つも無い(空振り)').toBeGreaterThan(1);
    for (const sh of PLACE_SHAPES) {
      expect(code, `place-shape-${sh} の受け手が無い ── 押しても無言で何も起きない`).toContain(
        `'place-shape-${sh}': placeShapeHandler('${sh}'),`,
      );
    }
  });

  it('⚠ 空振り防止 ── 在りもしない形の受け手は無い', () => {
    expect(code).not.toContain("'place-shape-circle'");
  });
});

/**
 * 🔴 **押したら本文が書き換わる**。
 * ⚠ ここは `body-rewrite` の入口だけを見る(reducer の門は `state.test.ts` 側)。
 */
describe('本文の書き換え(body-rewrite)', () => {
  it('🔴 形の指示が開き行へ届く', () => {
    const next = applyBodyRewrite(BODY, {
      kind: 'place-shape',
      line: 0,
      openLine: OPEN,
      shape: 'ellipse',
    });
    expect(next?.split('\n')[0]).toContain('shape=ellipse');
  });

  it('🔴 開き行がずれていたら書かない', () => {
    const next = applyBodyRewrite(BODY, {
      kind: 'place-shape',
      line: 0,
      openLine: ':::format{.pkc-place x=99 y=99}',
      shape: 'ellipse' as PlaceShape,
    });
    expect(next).toBeNull();
  });
});
