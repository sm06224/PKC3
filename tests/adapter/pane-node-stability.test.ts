/** @vitest-environment happy-dom */
/**
 * 🔴 **押される寸前のボタンを捨てない**(2026-08-06)。
 *
 * ## 何が起きていたか
 *
 * 保存すると storage worker の ack が**遅れて**届き、`ENTRY_STAMPED` が
 * `entryMetas` を**必ず新しい Map / 新しい meta 参照**で差し替える。
 * 情報ペイン(`inspector.ts`)とファイラ(`filer.ts`)はその参照を指紋にしていたので、
 * ack が着弾した瞬間に `region.textContent = ''` で**器ごと作り直していた**。
 *
 * - `show-history` / `delete-entry` / 「ゴミ箱」/「移動」の `<button>` が**別の node** になる
 * - binder は委譲 + `closest` で拾い、**`root.contains(el)` を通らない target を黙って捨てる**
 *   (`binder.ts`)── 保存直後に押すと **無言の dead click**
 * - しかも情報ペインが出す時刻は**日付だけ**、ファイラは `MM/DD` なので、
 *   同日の保存では**作り直した結果が byte 同一**。「同じ絵を描き直すために、
 *   user が押そうとしているボタンを捨てて」いた
 *
 * ⚠ これは PKC2 の失敗と同型(「編集のたびに一覧を全行作り直す」)。一覧は直したのに、
 * P8 で後から生えた 2 面が同じ罠を再発明していた。
 *
 * ## なぜこの観測点なのか
 *
 * 🔴 **壊れる当の振る舞いを直接見る**(CLAUDE.md)── 「日付が出ている」のような
 * **下流の結果**を見る test は、作り直しても値が同じなので**素通りする**(実際に
 * 素通りしていた)。だからここは **node の同一性**そのものを assert する。
 * ⚠ CI の smoke(`boot-edit`)はこれを「element is not stable」という**症状**の側から
 * 2 晩踏んだが、症状は retry で消せてしまう ── 原因の側に門を置く。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AppState } from '../../src/adapter/state/app-state';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';

const META = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'e1',
  title: 'ノート',
  archetype: 'text',
  entryOrder: 0,
  createdAt: '2026-08-06 01:02:03',
  updatedAt: '2026-08-06 01:02:03',
  status: null,
  date: null,
  archived: false,
  ...over,
});

/** 最小の state。⚠ 画面が読む field だけを持つ(足りなければ tsc が言う)。 */
function stateOf(metas: EntryMeta[], over: Partial<AppState> = {}): AppState {
  return {
    phase: 'ready',
    selectedLid: metas[0]?.lid ?? null,
    entryMetas: new Map(metas.map((m) => [m.lid, m])),
    relations: [],
    linkedFiles: new Map(),
    trashPanel: null,
    filterQuery: '',
    ...over,
  } as unknown as AppState;
}

/**
 * 保存 ack(`ENTRY_STAMPED`)が state に当たった形を作る。
 * 🔑 **本物と同じ作り方**にする(`app-state.ts` は `new Map(...)` + `{...meta}`)──
 * ここで同じ参照を使い回すと、この test は**何も検査しない**。
 */
function afterStampAck(prev: AppState, at: string): AppState {
  const metas = new Map(prev.entryMetas);
  for (const [lid, m] of prev.entryMetas) metas.set(lid, { ...m, updatedAt: at });
  return { ...prev, entryMetas: metas } as AppState;
}

let region: HTMLElement;
beforeEach(() => {
  document.body.textContent = '';
  region = document.createElement('div');
  document.body.append(region);
});

describe('情報ペイン: 保存の ack で node が差し替わらない', () => {
  it('🔴 ack が来ても `show-history` / `delete-entry` は**同じ node**', () => {
    const ins = new InspectorRenderer(region);
    let s = stateOf([META()]);
    ins.render(s);
    const before = [...region.querySelectorAll('[data-pkc-action]')];
    expect(before.length, '操作のボタンが出ていない(fixture が空振り)').toBeGreaterThanOrEqual(3);
    const history = region.querySelector('[data-pkc-action="show-history"]');
    const del = region.querySelector('[data-pkc-action="delete-entry"]');
    expect(history, '履歴のボタンが無い').not.toBeNull();

    // 保存の ack が着弾(同じ日 ── 画面に出る文字は 1 字も変わらない)
    s = afterStampAck(s, '2026-08-06 09:10:11');
    ins.render(s);

    expect(
      region.querySelector('[data-pkc-action="show-history"]'),
      '履歴のボタンが差し替わった(押される寸前に消える = 無言の dead click)',
    ).toBe(history);
    expect(region.querySelector('[data-pkc-action="delete-entry"]'), '削除が差し替わった').toBe(del);
  });

  it('⚠ 日付が実際に変わる ack でも node は同じ(値だけ変わる)', () => {
    const ins = new InspectorRenderer(region);
    let s = stateOf([META()]);
    ins.render(s);
    const history = region.querySelector('[data-pkc-action="show-history"]');
    const updated = region.querySelector('[data-pkc-field="inspector-updated"]');
    const shown = updated!.textContent;

    s = afterStampAck(s, '2026-08-07 04:05:06'); // 日が変わった
    ins.render(s);

    expect(region.querySelector('[data-pkc-action="show-history"]'), 'node が差し替わった').toBe(
      history,
    );
    // ⚠ 「node が同じ」だけ見ると、**値を更新しない実装**が通ってしまう
    expect(region.querySelector('[data-pkc-field="inspector-updated"]')!.textContent).not.toBe(
      shown,
    );
  });

  it('🔴 選択を切り替えたら、ボタンの居場所(`data-pkc-entry`)も付いて行く', () => {
    const ins = new InspectorRenderer(region);
    const a = META({ lid: 'a1', title: 'A' });
    const b = META({ lid: 'b1', title: 'B' });
    let s = stateOf([a, b]);
    ins.render(s);
    expect(region.querySelector('[data-pkc-action="delete-entry"]')!.getAttribute('data-pkc-entry')).toBe(
      'a1',
    );

    s = { ...s, selectedLid: 'b1' } as AppState;
    ins.render(s);
    // ⚠ ここを落とすと「削除」が**別のノートを消す**(ファイラの帯で実際に踏んだ形)
    expect(
      region.querySelector('[data-pkc-action="delete-entry"]')!.getAttribute('data-pkc-entry'),
      '前のノートを指したままのボタンが残っている',
    ).toBe('b1');
    expect(region.querySelector('[data-pkc-field="inspector-title"]')!.textContent).toBe('B');
  });

  it('⚠ 形が変わるとき(「書き戻す」の出入り)は組み直してよい', () => {
    const ins = new InspectorRenderer(region);
    let s = stateOf([META()]);
    ins.render(s);
    expect(region.querySelector('[data-pkc-action="write-back-file"]')).toBeNull();

    s = { ...s, linkedFiles: new Map([['e1', 'memo.md']]) } as AppState;
    ins.render(s);
    expect(
      region.querySelector('[data-pkc-action="write-back-file"]'),
      '紐づけが届いても「書き戻す」が出ない',
    ).not.toBeNull();
    expect(region.querySelector('[data-pkc-field="inspector-linked-file"]')!.textContent).toBe(
      'memo.md',
    );
  });

  it('⚠ 編集中は押せなくなる(node は同じまま)', () => {
    const ins = new InspectorRenderer(region);
    let s = stateOf([META()]);
    ins.render(s);
    const history = region.querySelector<HTMLButtonElement>('[data-pkc-action="show-history"]')!;
    expect(history.disabled).toBe(false);

    s = { ...s, phase: 'editing' } as AppState;
    ins.render(s);
    expect(region.querySelector('[data-pkc-action="show-history"]'), 'node が差し替わった').toBe(
      history,
    );
    expect(history.disabled, '編集中に押せるままになっている').toBe(true);
    expect(history.title).toContain('編集中は使えません');
  });
});

describe('ファイラ: 見た目が変わらない ack で作り直さない', () => {
  it('🔴 同じ日の ack では「ゴミ箱」の node が生き残る', () => {
    const filer = new FilerRenderer(region);
    let s = stateOf([META()]);
    filer.render(s);
    const trash = region.querySelector('[data-pkc-action="show-trash"]');
    expect(trash, 'ゴミ箱の導線が出ていない(fixture が空振り)').not.toBeNull();

    // 同じ日の保存 ── ファイラが出すのは `MM/DD` なので**表示は不変**
    s = afterStampAck(s, '2026-08-06 23:59:59');
    filer.render(s);

    expect(
      region.querySelector('[data-pkc-action="show-trash"]'),
      '見た目が変わらない ack で面ごと作り直している',
    ).toBe(trash);
  });

  it('⚠ 日付が実際に変わる ack では作り直して値を出す(止めすぎていない)', () => {
    const filer = new FilerRenderer(region);
    let s = stateOf([META()]);
    filer.render(s);
    const cell = region.querySelector('[data-pkc-region="filer-table"] tbody td:nth-child(2)');
    const shown = cell!.textContent;

    s = afterStampAck(s, '2026-09-30 01:02:03'); // 月日が変わった
    filer.render(s);

    expect(
      region.querySelector('[data-pkc-region="filer-table"] tbody td:nth-child(2)')!.textContent,
      '更新日が古いまま(指紋が内容を見ていない)',
    ).not.toBe(shown);
  });

  it('⚠ 題名が変わる ack は作り直す(指紋が題名を見ている)', () => {
    const filer = new FilerRenderer(region);
    let s = stateOf([META()]);
    filer.render(s);
    const metas = new Map(s.entryMetas);
    metas.set('e1', { ...metas.get('e1')!, title: '改名した' });
    s = { ...s, entryMetas: metas } as AppState;
    filer.render(s);
    expect(region.querySelector('[data-pkc-region="filer-table"] tbody')!.textContent).toContain(
      '改名した',
    );
  });
});
