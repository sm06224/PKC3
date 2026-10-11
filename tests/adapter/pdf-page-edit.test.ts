/**
 * ページの編集の計画(`public/pdf/page-edit.js`)── 画面の操作を「作り方」に直す純粋な判断(#275 段②-1b)。
 *
 * 🔴 守るもの: ①回す角度が足し算で 360° に戻る ②外す・並べ替える後の `order` が**画面の並びそのもの**
 * ③依頼(`toJob`)が**元のページ番号**で書かれる(画面の位置ではない)④元のままなら「変わっていない」
 * ⑤0 ページは保存できない ⑥保存の前の 1 行は、引き継がれない物が**元にあるときだけ**それを言う。
 * ⚠ **この file の原文を読んで走らせる**(`public/` は bundle を通らないので import できない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Item {
  page: number;
  rot: number;
}
interface Api {
  fresh(total: number): Item[];
  rotateAt(items: Item[], at: number): Item[];
  removeAt(items: Item[], at: number): Item[];
  moveTo(items: Item[], from: number, to: number): Item[];
  isChanged(items: Item[], total: number): boolean;
  toJob(items: Item[]): { order: number[]; rotate: Record<string, number> };
  canSave(items: Item[]): boolean;
  outputName(name: string): string;
  sameArrangement(a: Item[], b: Item[]): boolean;
  noteLine(kept: number, total: number): string;
  warnLine(info: { outlines: boolean; form: boolean; signature: boolean }): string;
}

function load(): Api {
  const root: { PkcPdfPageEdit?: Api } = {};
  new Function('self', readFileSync('public/pdf/page-edit.js', 'utf-8'))(root);
  expect(root.PkcPdfPageEdit, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfPageEdit as Api;
}
const api = load();
const pages = (items: Item[]): number[] => items.map((i) => i.page);
const none = { outlines: false, form: false, signature: false };

describe('元のまま', () => {
  it('fresh は 1..N を回さずに並べる / 元のままなら toJob は回転を載せず、isChanged は偽', () => {
    const f = api.fresh(4);
    expect(f).toEqual([
      { page: 1, rot: 0 },
      { page: 2, rot: 0 },
      { page: 3, rot: 0 },
      { page: 4, rot: 0 },
    ]);
    expect(api.isChanged(f, 4)).toBe(false);
    expect(api.toJob(f)).toEqual({ order: [1, 2, 3, 4], rotate: {} });
  });
});

describe('回す ── 右へ 90° ずつ足し、360° で 0 に戻る', () => {
  it('1 回 90 / 2 回 180 / 3 回 270 / 4 回で元(0)', () => {
    let items = api.fresh(3);
    const seen: number[] = [];
    for (let k = 0; k < 4; k += 1) {
      items = api.rotateAt(items, 2);
      seen.push((items[2] as Item).rot);
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    // 4 回で元に戻ったら「変えていない」(保存ボタンを出さない)
    expect(api.isChanged(items, 3)).toBe(false);
  });

  it('回したページだけが依頼に載る(元のページ番号で)', () => {
    const items = api.rotateAt(api.rotateAt(api.fresh(3), 2), 2);
    expect(api.toJob(items)).toEqual({ order: [1, 2, 3], rotate: { 3: 180 } });
    expect(api.isChanged(items, 3)).toBe(true);
  });

  it('範囲の外を指しても壊れない(同じ並びの複製を返す)/ 元の配列は書き換えない', () => {
    const f = api.fresh(2);
    expect(api.rotateAt(f, 5)).toEqual(f);
    expect(api.rotateAt(f, -1)).toEqual(f);
    api.rotateAt(f, 0);
    expect(f[0]).toEqual({ page: 1, rot: 0 });
  });
});

describe('外す', () => {
  it('外したページは依頼の order から消え、残りの番号は元のまま(詰め直さない)', () => {
    const items = api.removeAt(api.fresh(4), 1);
    expect(api.toJob(items).order).toEqual([1, 3, 4]);
    expect(api.isChanged(items, 4)).toBe(true);
  });

  it('外したページに載っていた回転は依頼に残らない', () => {
    let items = api.rotateAt(api.fresh(3), 1);
    items = api.removeAt(items, 1);
    expect(api.toJob(items)).toEqual({ order: [1, 3], rotate: {} });
  });

  it('全部外したら保存できない(0 ページの PDF は作らない)/ 1 つ残っていれば保存できる', () => {
    let items = api.fresh(2);
    items = api.removeAt(items, 0);
    expect(api.canSave(items)).toBe(true);
    items = api.removeAt(items, 0);
    expect(items).toEqual([]);
    expect(api.canSave(items)).toBe(false);
    // 全部外した状態は「変えた」(元のまま扱いで保存ボタンごと隠さない ── 無効にして理由を言う)
    expect(api.isChanged(items, 2)).toBe(true);
  });
});

describe('並べ替え ── ドラッグも Alt+↑↓ も moveTo 1 本', () => {
  it('取り出した後の並びの to 番目へ入る', () => {
    const f = api.fresh(5);
    expect(pages(api.moveTo(f, 0, 2))).toEqual([2, 3, 1, 4, 5]);
    expect(pages(api.moveTo(f, 4, 0))).toEqual([5, 1, 2, 3, 4]);
    expect(pages(api.moveTo(f, 1, 2))).toEqual([1, 3, 2, 4, 5]);
  });

  it('端に丸める / 動かないなら同じ並び / 範囲の外の from は何もしない', () => {
    const f = api.fresh(3);
    expect(pages(api.moveTo(f, 0, -5))).toEqual([1, 2, 3]);
    expect(pages(api.moveTo(f, 2, 99))).toEqual([1, 2, 3]);
    expect(pages(api.moveTo(f, 1, 1))).toEqual([1, 2, 3]);
    expect(pages(api.moveTo(f, 7, 0))).toEqual([1, 2, 3]);
  });

  it('並べ替えただけでも「変えた」/ 戻せば「変えていない」', () => {
    const f = api.fresh(3);
    const moved = api.moveTo(f, 0, 2);
    expect(api.isChanged(moved, 3)).toBe(true);
    expect(api.toJob(moved).order).toEqual([2, 3, 1]);
    expect(api.isChanged(api.moveTo(moved, 2, 0), 3)).toBe(false);
  });

  it('並べ替え・回す・外すの合成: 依頼は「元のページ番号」で書かれる', () => {
    // 5 ページ: 4 を先頭へ → 2 を外す → 元の 5 を右へ回す
    let items = api.fresh(5);
    items = api.moveTo(items, 3, 0); // [4,1,2,3,5]
    items = api.removeAt(items, 2); // [4,1,3,5]
    items = api.rotateAt(items, 3); // 5 を 90°
    expect(api.toJob(items)).toEqual({ order: [4, 1, 3, 5], rotate: { 5: 90 } });
  });

  it('動かしても回転は一緒に付いていく', () => {
    let items = api.rotateAt(api.fresh(3), 0); // 1 を 90°
    items = api.moveTo(items, 0, 2); // [2,3,1]
    expect(api.toJob(items)).toEqual({ order: [2, 3, 1], rotate: { 1: 90 } });
  });
});

describe('保存する PDF の名前', () => {
  it('`元の名前.pdf` → `元の名前 (編集).pdf` / 拡張子の大小は問わない / 無ければ付ける', () => {
    expect(api.outputName('報告書.pdf')).toBe('報告書 (編集).pdf');
    expect(api.outputName('Report.PDF')).toBe('Report (編集).pdf');
    expect(api.outputName('メモ')).toBe('メモ (編集).pdf');
  });

  it('編集したものを編集しても (編集) を重ねない / 空なら既定の名前', () => {
    expect(api.outputName('報告書 (編集).pdf')).toBe('報告書 (編集).pdf');
    expect(api.outputName('')).toBe('document (編集).pdf');
    expect(api.outputName('.pdf')).toBe('document (編集).pdf');
  });
});

describe('保存した並びを基準にする(保存した後に、保存ボタンを出し直さない)', () => {
  it('同じページ・同じ順・同じ向きなら同じ / どれか 1 つでも違えば違う', () => {
    const f = api.fresh(3);
    expect(api.sameArrangement(f, api.fresh(3))).toBe(true);
    expect(api.sameArrangement(f, api.rotateAt(f, 1))).toBe(false);
    expect(api.sameArrangement(f, api.moveTo(f, 0, 1))).toBe(false);
    expect(api.sameArrangement(f, api.removeAt(f, 2))).toBe(false);
    const edited = api.rotateAt(api.removeAt(f, 1), 0);
    expect(api.sameArrangement(edited, edited.map((i) => ({ ...i })))).toBe(true);
  });
});

describe('編集中の案内の 1 行 / 引き継がれない物の行', () => {
  it('案内は短く、保存すると新しい PDF として加わり、元は変わらないと言う(引き継がれない物の字は入れない)', () => {
    const line = api.noteLine(2, 3);
    expect(line).toContain('2 / 3 ページ');
    expect(line).toContain('新しい PDF として添付に加わります');
    expect(line).toContain('元の PDF は変わりません');
    for (const w of ['しおり', '入力欄', '電子署名']) expect(line).not.toContain(w);
    expect(line.length, '案内が長くて折り返す').toBeLessThanOrEqual(60);
  });

  it('全部外したら、保存できない理由を言う', () => {
    const line = api.noteLine(0, 3);
    expect(line).toContain('保存できません');
    expect(line).not.toContain('新しい PDF として');
  });

  it('引き継がれない物の行: 元に何も無ければ空(行ごと出さない)', () => {
    expect(api.warnLine(none)).toBe('');
  });

  it('あるものだけ、それぞれの字を出す(3 つは独立)', () => {
    expect(api.warnLine({ ...none, outlines: true })).toBe('しおりは引き継がれません。');
    expect(api.warnLine({ ...none, form: true })).toBe('入力欄は引き継がれません。');
    expect(api.warnLine({ ...none, signature: true })).toBe('電子署名は無効になります。');
    const all = api.warnLine({ outlines: true, form: true, signature: true });
    for (const w of ['しおり', '入力欄', '電子署名']) expect(all).toContain(w);
  });
});
