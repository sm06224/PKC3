/** @vitest-environment happy-dom */
/**
 * #399 ①: **フォルダ書き出しが、押した所から届くまで**。
 *
 * 🔴 **配線の test を別に置く理由**(#397 で踏んだばかり):器を作っただけ /
 * 実装を書いただけで「できた」と言うと、**押しても何も起きない**ものが出荷される。
 * `folder-source.test.ts` は絞り込みの正しさを見るが、それが**画面から届くか**は
 * 1 行も見ていない ── ここがその 1 行である。
 *
 * 見るのは 3 点:
 * ① フォルダを選んでいるときだけボタンが**見える**
 * ② 押すと `exportFolder` が **その lid で**呼ばれる
 * ③ 🔴 **行から押したら、その行の lid** で呼ばれる(隣の「削除」と同じ解決規則 ──
 *    揃っていないと「A を書き出して B を削除する」が成立する)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const METAS = [meta('f1', 1, 'folder'), meta('n1', 2)];

/**
 * ⚠ **毎回 body を空にする**(#397 で踏んだ)── 器は
 * `closest('[data-pkc-slot="root"]')` で辿るので、前の test が残した器が
 * 生きていると**そちらを掴む**(`data-pkc-slot="root"` は `index.html` 側に在り、
 * `buildShell` は作らないので、辿りは `document.body` まで落ちる)。
 */
beforeEach(() => {
  document.body.textContent = '';
});

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const asked: string[] = [];
  const d = new Dispatcher(initialState);
  bindActions(root, d, { exportFolder: (lid) => void asked.push(lid) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const select = (lid: string): AppState => {
    const s = reduce(d.getState(), { type: 'SELECT_ENTRY', lid }).state;
    inspector.render(s);
    return s;
  };
  const btn = (): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('[data-pkc-action="export-folder"]');
  return { root, asked, select, btn };
}

describe('#399 ① フォルダ書き出しの配線', () => {
  it('🔑 フォルダを選んでいるときは見える', () => {
    const r = rig();
    r.select('f1');
    expect(r.btn(), 'ボタンそのものが無い').not.toBeNull();
    expect(r.btn()!.hidden, 'フォルダなのに畳まれている').toBe(false);
  });

  it('🔴 ノートを選んでいるときは畳む ── 押せるのに必ず失敗する形を作らない', () => {
    const r = rig();
    r.select('n1');
    expect(r.btn()!.hidden, 'フォルダでないのに押せる').toBe(true);
  });

  it('🔴 選び直すと畳みも切り替わる(前の選択のまま残さない)', () => {
    const r = rig();
    r.select('f1');
    expect(r.btn()!.hidden).toBe(false);
    r.select('n1');
    expect(r.btn()!.hidden, '選び直したのに前のまま').toBe(true);
    r.select('f1');
    expect(r.btn()!.hidden).toBe(false);
  });

  it('🔴 押すと、そのフォルダの lid で呼ばれる', () => {
    const r = rig();
    r.select('f1');
    r.btn()!.click();
    expect(r.asked).toEqual(['f1']);
  });

  it('🔴 行から押したら、その行の lid(隣の「削除」と同じ解決規則)', () => {
    const r = rig();
    r.select('f1');
    // 一覧の行を模す ── 選択は f1 のまま、押すのは別の器の中のボタン
    const row = document.createElement('div');
    row.setAttribute('data-pkc-entry', 'other');
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'export-folder');
    row.append(b);
    r.root.append(row);
    b.click();
    expect(r.asked, '選択中の lid を使ってしまっている').toEqual(['other']);
  });

  it('⚠ 説明が付いている(押す前に「何が入らないか」が分かる)', () => {
    const r = rig();
    r.select('f1');
    expect(r.btn()!.title).toContain('取り込み直せます');
    expect(r.btn()!.title, '落ちるものを言っていない').toContain('外へ繋がる関係');
  });
});
