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
  isKept(items: Item[], page: number): boolean;
  onKeptPages<T extends { page: number }>(list: T[], items: Item[]): T[];
  REMOVED_PAGE_REFUSAL: string;
  sameArrangement(a: Item[], b: Item[]): boolean;
  noteLine(kept: number, total: number): string;
  warnLine(info: { outlines: boolean; form: boolean; signature: boolean }): string;
  toggleSel(sel: Set<number>, page: number): Set<number>;
  rangeSel(items: Item[], a: number, b: number): Set<number>;
  pruneSel(sel: Set<number>, items: Item[]): Set<number>;
  pickSelected(items: Item[], sel: Set<number>): Item[];
  canExtract(items: Item[], sel: Set<number>): boolean;
  extractName(name: string): string;
  pickNote(count: number): string;
  replyMatches(pending: { key: string } | null, payload: unknown): boolean;
  appendPages(items: Item[], first: number, count: number): Item[];
  sourcesFor(list: Item[], added: { first: number; count: number }[]): { sources: { first: number; count: number }[]; used: number[] };
  appendRefusal(code: unknown): string;
  appendedNote(name: string, count: number): string;
  removeSource(
    items: Item[],
    added: { first: number; count: number }[],
    k: number,
  ): { items: Item[]; added: { first: number; count: number }[] };
  sourceHeadings(items: Item[], added: { first: number; count: number }[]): { page: number; k: number }[];
  headingText(name: string, count: number): string;
  attachRefusal(code: string): string;
  attachLabel(name: string, size: number | null): string;
  restorePage(items: Item[], page: number): Item[];
  removedPages(items: Item[], grand: number, live?: (p: number) => boolean): number[];
  thumbNoText(page: number, pos: number, total: number): string;
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

  it('編集したものを編集したら、(編集) を重ねず番号を付ける: (編集) → (編集 2) → (編集 3) … / 空なら既定の名前', () => {
    expect(api.outputName('報告書 (編集).pdf')).toBe('報告書 (編集 2).pdf');
    expect(api.outputName('報告書 (編集 2).pdf')).toBe('報告書 (編集 3).pdf');
    expect(api.outputName('報告書 (編集 9).pdf')).toBe('報告書 (編集 10).pdf');
    // 3 回続けても、名前は毎回変わる(前の物と同じ名前にならない)
    let n = '報告書.pdf';
    const seen = new Set<string>([n]);
    for (let i = 0; i < 3; i += 1) {
      n = api.outputName(n);
      expect(seen.has(n), n).toBe(false);
      seen.add(n);
    }
    expect([...seen]).toEqual(['報告書.pdf', '報告書 (編集).pdf', '報告書 (編集 2).pdf', '報告書 (編集 3).pdf']);
    // 末尾でない (編集) は番号の対象ではない
    expect(api.outputName('(編集) 資料.pdf')).toBe('(編集) 資料 (編集).pdf');
    expect(api.outputName('')).toBe('document (編集).pdf');
    expect(api.outputName('.pdf')).toBe('document (編集).pdf');
  });
});

describe('外したページに付けた物は、保存前の案内の数に入れない(#1163 依頼 99-5)', () => {
  it('isKept / onKeptPages: いまの並びに残っているページの物だけ残す(外したページの物は除く)', () => {
    const items = api.removeAt(api.fresh(4), 1); // 2 ページ目を外した → 1, 3, 4
    expect(api.isKept(items, 1)).toBe(true);
    expect(api.isKept(items, 2)).toBe(false);
    const list = [{ page: 1, id: 'a' }, { page: 2, id: 'b' }, { page: 3, id: 'c' }, { page: 2, id: 'd' }];
    expect(api.onKeptPages(list, items).map((o) => o.id)).toEqual(['a', 'c']);
    // 対照群: 外していなければ全部残る(除く側が常に除いているのではない)
    expect(api.onKeptPages(list, api.fresh(4))).toHaveLength(4);
    // 戻せば、また数える
    expect(api.onKeptPages(list, api.restorePage(items, 2))).toHaveLength(4);
  });

  it('外したページへの断りの字: 何を付けられないかと、戻し方を言う(画面に在る「戻す」を指す)', () => {
    expect(api.REMOVED_PAGE_REFUSAL).toContain('外したページ');
    expect(api.REMOVED_PAGE_REFUSAL).toContain('付箋・ペン・ハイライト');
    expect(api.REMOVED_PAGE_REFUSAL).toContain('戻す');
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

describe('選ぶ・抜き出す(#275 段②-1c)', () => {
  // 並べ替えて 3 を回し、5 を外した後の一覧: 4, 3(右へ 90°), 1, 2
  const list: Item[] = [
    { page: 4, rot: 0 },
    { page: 3, rot: 90 },
    { page: 1, rot: 0 },
    { page: 2, rot: 0 },
  ];

  it('🔴 選んだページだけが、一覧の並びと向きのまま残る(選んだ順ではなく、見えている順)', () => {
    const picked = api.pickSelected(list, new Set([2, 3]));
    expect(picked).toEqual([
      { page: 3, rot: 90 },
      { page: 2, rot: 0 },
    ]);
    // 抜き出す依頼は元のページ番号で、回したページの角度を持つ
    expect(api.toJob(picked)).toEqual({ order: [3, 2], rotate: { 3: 90 } });
    // 選んでいないページは 1 つも入らない
    expect(pages(picked)).not.toContain(1);
    expect(pages(picked)).not.toContain(4);
  });

  it('🔴 0 件では抜き出せない / 一覧に無いページしか選んでいなくても抜き出せない(外したページは数えない)', () => {
    expect(api.canExtract(list, new Set())).toBe(false);
    expect(api.canExtract(list, new Set([5]))).toBe(false);
    expect(api.canExtract(list, new Set([5, 2]))).toBe(true);
  });

  it('toggleSel は入れ替える(元の集まりは変えない)/ rangeSel は一覧の並びで両端を含む(向きは問わない)', () => {
    const base = new Set([1]);
    const on = api.toggleSel(base, 2);
    expect([...on].sort()).toEqual([1, 2]);
    expect([...base]).toEqual([1]);
    expect([...api.toggleSel(on, 1)]).toEqual([2]);
    // 見えている順 4,3,1,2 の「3 から 2」= 3,1,2。ページ番号の大小ではない
    expect([...api.rangeSel(list, 3, 2)].sort()).toEqual([1, 2, 3]);
    expect([...api.rangeSel(list, 2, 3)].sort()).toEqual([1, 2, 3]);
    expect([...api.rangeSel(list, 4, 4)]).toEqual([4]);
    // 一覧に無いページが端なら空
    expect(api.rangeSel(list, 5, 2).size).toBe(0);
  });

  it('pruneSel: 外したページは選びから落ちる', () => {
    expect([...api.pruneSel(new Set([1, 5, 3]), list)].sort()).toEqual([1, 3]);
  });

  it('extractName: 「元の名前 (抜き出し).pdf」/ 重ねない / 拡張子の大小・無し・空', () => {
    expect(api.extractName('報告書.pdf')).toBe('報告書 (抜き出し).pdf');
    expect(api.extractName('A.PDF')).toBe('A (抜き出し).pdf');
    expect(api.extractName('報告書 (抜き出し).pdf')).toBe('報告書 (抜き出し).pdf');
    expect(api.extractName('memo')).toBe('memo (抜き出し).pdf');
    expect(api.extractName('')).toBe('document (抜き出し).pdf');
    // 編集の名前とは別(同じ PDF から保存と抜き出しをしても、名前が重ならない)
    expect(api.extractName('x.pdf')).not.toBe(api.outputName('x.pdf'));
  });

  it('pickNote は選んだ数と、元の PDF が変わらないことを言う', () => {
    const t = api.pickNote(3);
    expect(t).toContain('3 ページ');
    expect(t).toContain('選んだページを別の PDF にする');
    expect(t).toContain('元の PDF は変わりません');
  });
});

describe('本体の返事を依頼に突き合わせる(#275 段②-1c)', () => {
  it('🔴 時間切れの後に遅れて届いた前の依頼の返事は、次の依頼の返事として受けない(保存と抜き出しの取り違え)', () => {
    // 保存(鍵 A)を送る → 時間切れ → 抜き出し(鍵 B)を送る → A の遅い返事が届く
    let pending: { key: string } | null = { key: 'pA' };
    // A の返事は A の間は受ける
    expect(api.replyMatches(pending, { ok: true, key: 'pA' })).toBe(true);
    pending = { key: 'pB' };
    expect(api.replyMatches(pending, { ok: true, key: 'pA' }), 'A の遅い返事を B の返事として受けた').toBe(false);
    expect(api.replyMatches(pending, { ok: true, key: 'pB' })).toBe(true);
  });

  it('鍵が無い・型が違う・控えが無い返事は受けない', () => {
    expect(api.replyMatches({ key: 'pA' }, { ok: true })).toBe(false);
    expect(api.replyMatches({ key: 'pA' }, { ok: true, key: 5 })).toBe(false);
    expect(api.replyMatches({ key: 'pA' }, null)).toBe(false);
    expect(api.replyMatches(null, { ok: true, key: 'pA' })).toBe(false);
  });
});

describe('別の PDF を足す(#275 結合)── 通し番号で元のページと同じ操作ができる', () => {
  it('足したページは並びの最後に、回していない形で付く / 元の並びは書き換えない', () => {
    const base = api.fresh(3);
    const next = api.appendPages(base, 4, 2);
    expect(next).toEqual([...base, { page: 4, rot: 0 }, { page: 5, rot: 0 }]);
    expect(base).toHaveLength(3);
    // 元のページと同じ関数で動く(回す・並べ替え・外す)── 依頼は通し番号で書かれる
    const worked = api.removeAt(api.moveTo(api.rotateAt(next, 4), 4, 0), 1);
    expect(api.toJob(worked)).toEqual({ order: [5, 2, 3, 4], rotate: { 5: 90 } });
    // 足しただけで「保存していない変更」になる(保存ボタンが出る)/ 足す前の並び(基準)に戻せば変更なし
    expect(api.sameArrangement(next, base)).toBe(false);
    expect(api.sameArrangement(base, base.slice())).toBe(true);
  });

  it('sourcesFor: ページが残っている PDF だけを、使う順に挙げる(使わない PDF の bytes は送らない)', () => {
    const added = [
      { first: 4, count: 2 },
      { first: 6, count: 3 },
    ];
    const list = api.appendPages(api.fresh(3), 4, 5);
    expect(api.sourcesFor(list, added)).toEqual({ sources: added, used: [0, 1] });
    // 1 つ目の PDF のページを全部外す → 2 つ目だけ(添字は added の何番目か)
    const cut = list.filter((it) => it.page < 4 || it.page > 5);
    expect(api.sourcesFor(cut, added)).toEqual({ sources: [{ first: 6, count: 3 }], used: [1] });
    // 1 枚でも残っていれば使う / 元のページだけなら何も使わない
    expect(api.sourcesFor(api.fresh(3).concat([{ page: 5, rot: 0 }]), added).used).toEqual([0]);
    expect(api.sourcesFor(api.fresh(3), added)).toEqual({ sources: [], used: [] });
  });

  it('removeSource: 足した PDF のページを全部外す(別の場所へ動かしたページも)/ added からも落とす / 範囲外は何もしない', () => {
    const added = [
      { first: 4, count: 2 },
      { first: 6, count: 3 },
    ];
    // 1 つ目の PDF のページ(4)を元のページの間へ動かしておく
    const moved = api.moveTo(api.appendPages(api.fresh(3), 4, 5), 3, 1);
    expect(pages(moved)).toEqual([1, 4, 2, 3, 5, 6, 7, 8]);
    const r = api.removeSource(moved, added, 0);
    expect(pages(r.items)).toEqual([1, 2, 3, 6, 7, 8]);
    expect(r.added).toEqual([{ first: 6, count: 3 }]);
    // 元の入力は変えない
    expect(added).toHaveLength(2);
    expect(pages(moved)).toEqual([1, 4, 2, 3, 5, 6, 7, 8]);
    // 回してあるページの向きは、残るページでは保たれる
    const turned = api.rotateAt(api.appendPages(api.fresh(2), 3, 2), 3);
    expect(api.removeSource(turned, [{ first: 3, count: 2 }], 0).items).toEqual(api.fresh(2));
    expect(api.removeSource(moved, added, 1).items.map((i) => i.page)).toEqual([1, 4, 2, 3, 5]);
    // 範囲の外 ── 同じ内容の写し
    for (const k of [-1, 2]) {
      const same = api.removeSource(moved, added, k);
      expect(same.items).toEqual(moved);
      expect(same.items).not.toBe(moved);
      expect(same.added).toEqual(added);
    }
    // 外した結果は、送る PDF からも落ちる(bytes を送らない)
    const kept = api.removeSource(moved, added, 0);
    expect(api.sourcesFor(kept.items, kept.added).sources).toEqual([{ first: 6, count: 3 }]);
  });

  it('sourceHeadings: 各 PDF の最初に出るページの前に 1 つ ── 並べ替えたら先に出る側 / 残っていない PDF は出さない', () => {
    const added = [
      { first: 4, count: 2 },
      { first: 6, count: 3 },
    ];
    const list = api.appendPages(api.fresh(3), 4, 5);
    expect(api.sourceHeadings(list, added)).toEqual([
      { page: 4, k: 0 },
      { page: 6, k: 1 },
    ]);
    // 元のページだけなら見出しは無い
    expect(api.sourceHeadings(api.fresh(3), added)).toEqual([]);
    // 2 つ目の PDF の 8 ページ目を先頭へ動かすと、2 つ目の見出しはそこ(いまの並びで先に出る側)
    const moved = api.moveTo(list, 7, 0);
    expect(api.sourceHeadings(moved, added)).toEqual([
      { page: 8, k: 1 },
      { page: 4, k: 0 },
    ]);
    // 1 つ目を全部外せば、1 つ目の見出しは消える
    const cut = list.filter((it) => it.page < 4 || it.page > 5);
    expect(api.sourceHeadings(cut, added)).toEqual([{ page: 6, k: 1 }]);
  });

  it('見出しの字は「名前(N ページ)」/ 添付の一覧の 1 行は大きさを添える', () => {
    expect(api.headingText('会議B.pdf', 3)).toBe('会議B.pdf(3 ページ)');
    expect(api.attachLabel('契約.pdf', null)).toBe('契約.pdf');
    expect(api.attachLabel('a.pdf', 500)).toBe('a.pdf(500 B)');
    expect(api.attachLabel('a.pdf', 2048)).toBe('a.pdf(2 KB)');
    expect(api.attachLabel('a.pdf', 1.25 * 1024 * 1024)).toBe('a.pdf(1.3 MB)');
  });

  it('添付から選ぶの断り: 無い / 取れない / 読めない ── 画面の字に造語を使わず、3 つが別の字', () => {
    const t = ['empty', 'no-reply', 'failed'].map((c) => api.attachRefusal(c));
    expect(new Set(t).size).toBe(3);
    expect(t[0]).toContain('PDF の添付はありません');
    expect(t[2]).toContain('何も変えていません');
  });

  it('断りの字: 暗号化 / 読めない / ほか ── どれも「何も変えていません」と言う', () => {
    expect(api.appendRefusal('encrypted')).toContain('パスワードで守られた PDF は足せません');
    expect(api.appendRefusal('unreadable')).toContain('PDF として読めないため足せません');
    expect(api.appendRefusal(undefined)).toContain('もう一度試してください');
    for (const c of ['encrypted', 'unreadable', 'worker']) expect(api.appendRefusal(c)).toContain('何も変えていません');
    expect(new Set(['encrypted', 'unreadable', 'worker'].map((c) => api.appendRefusal(c))).size).toBe(3);
  });

  it('足せた知らせは、名前・ページ数・保存の入口を言う(「別の PDF として保存」は画面のボタンの字)', () => {
    const t = api.appendedNote('資料.pdf', 2);
    expect(t).toContain('「資料.pdf」の 2 ページ');
    expect(t).toContain('「別の PDF として保存」');
    const host = readFileSync('public/pdf/host.html', 'utf-8');
    expect(host).toContain('>別の PDF として保存</button>');
  });
});

describe('外したページを 1 ページだけ戻す(#1663 依頼 49-3)', () => {
  it('戻したページは、元の並びで一つ前のページの後ろに入る(向きは回していない)', () => {
    const left = api.removeAt(api.removeAt(api.fresh(5), 3), 1); // 2 と 4 を外した → 1 3 5
    expect(pages(api.restorePage(left, 2))).toEqual([1, 2, 3, 5]);
    expect(pages(api.restorePage(left, 4))).toEqual([1, 3, 4, 5]);
    expect(api.restorePage(left, 4)[2]).toEqual({ page: 4, rot: 0 });
  });
  it('先頭のページを戻すと先頭に入り、ほかの編集(回した向き・並べ替え)は残る', () => {
    const rotated = api.rotateAt(api.fresh(3), 2); // 3 を回す
    const left = api.removeAt(rotated, 0); // 1 を外す → 2 3(回)
    const back = api.restorePage(left, 1);
    expect(pages(back)).toEqual([1, 2, 3]);
    expect(back[2]).toEqual({ page: 3, rot: 90 });
    const moved = api.moveTo(api.removeAt(api.fresh(4), 1), 2, 0); // 2 を外して 4 を先頭へ → 4 1 3
    expect(pages(api.restorePage(moved, 2))).toEqual([4, 1, 2, 3]);
  });
  it('並びに既にあるページは増やさない(対照群)。元の並びは書き換えない', () => {
    const items = api.fresh(3);
    expect(pages(api.restorePage(items, 2))).toEqual([1, 2, 3]);
    const left = api.removeAt(items, 1);
    api.restorePage(left, 2);
    expect(pages(left)).toEqual([1, 3]);
  });
  it('外してあるページの一覧は昇順。戻せない物(live が偽)は数えない', () => {
    const left = api.removeAt(api.removeAt(api.fresh(5), 3), 1);
    expect(api.removedPages(left, 5)).toEqual([2, 4]);
    expect(api.removedPages(left, 7, (p) => p <= 5)).toEqual([2, 4]);
    expect(api.removedPages(api.fresh(3), 3)).toEqual([]);
  });
  it('画面: 外したページの置き場に「戻す」が出て、押すと 1 ページだけ戻る(配線を原文で pin)', () => {
    const src = readFileSync('public/pdf/reader.js', 'utf-8');
    expect(src).toContain("'pdf-page-restore'");
    expect(src).toContain('pageEdit.restorePage(items, page)');
    expect(src).toContain("head.textContent = '外したページ'");
    expect(src).toContain("act.textContent = '戻す'");
  });
});

describe('並べ替えた後の一覧の番号(#1663 依頼 49-5)', () => {
  it('位置が元の番号と同じなら位置だけ、違えば「1(元の 5)」と両方を言う', () => {
    expect(api.thumbNoText(3, 3, 12)).toBe('3');
    expect(api.thumbNoText(5, 1, 12)).toBe('1(元の 5)');
    expect(api.thumbNoText(1, 2, 12)).toBe('2(元の 1)');
  });
  it('足したページ(通し番号が元の PDF の総数より大きい)は元の番号を言わない', () => {
    expect(api.thumbNoText(13, 2, 12)).toBe('2');
  });
  it('外して詰めた後は、位置と元の番号がずれる(1 3 4 5 → 1, 2(元の 3)…)', () => {
    const left = api.removeAt(api.fresh(5), 1);
    expect(left.map((it, k) => api.thumbNoText(it.page, k + 1, 5))).toEqual(['1', '2(元の 3)', '3(元の 4)', '4(元の 5)']);
  });
});
