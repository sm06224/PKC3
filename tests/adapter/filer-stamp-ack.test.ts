/** @vitest-environment happy-dom */
/**
 * 🔴 **保存の ack で一覧の指紋を全件作り直さない**(#1087)。
 *
 * ## 何が起きていたか
 *
 * 保存の ack(`ENTRY_STAMPED`)は `entryMetas` を新しい Map に差し替える。ファイラは参照が
 * 変わるたびに「一覧の指紋」と「日付の指紋」を**全件**作り直していた(5,000 件でそれぞれ約 2 ms ──
 * 変わったのは 1 件の更新日時だけ)。
 *
 * ## 🔑 直し
 *
 * 前回の一覧と並べ、違うのが時刻だけなら前の指紋を使う(`stampChanges`)。日付は、丸めた字も
 * 変わらないときだけ。
 *
 * ## 観測点
 *
 * 全件作り直しは**全件の題名を読む**(`metaSignature`)。題名の getter を数えて、
 * 「1 件の ack で読んだ回数が件数に比例しない」を見る。⚠ 見えるものは変えない
 * (行の node・日付の字・題名の更新)── 下の対照群が対で持つ。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';

const N = 200;
const YEAR = new Date().getFullYear();
const DAY1 = `${YEAR}-01-02 03:04:05`;

function plain(i: number): EntryMeta {
  return {
    lid: 'n' + i,
    title: '題名 ' + i,
    archetype: 'text',
    createdAt: DAY1,
    updatedAt: DAY1,
    entryOrder: i,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
  };
}

let titleReads = 0;
let updatedReads = 0;
/** 題名・更新日時を読まれた回数を数える meta(スプレッドしない ── 読み取りが数に入る)。 */
function counted(m: EntryMeta): EntryMeta {
  const c = { ...m };
  Object.defineProperty(c, 'title', {
    enumerable: true,
    get() {
      titleReads += 1;
      return m.title;
    },
  });
  Object.defineProperty(c, 'updatedAt', {
    enumerable: true,
    get() {
      updatedReads += 1;
      return m.updatedAt;
    },
  });
  return c;
}

const base = (): EntryMeta[] => Array.from({ length: N }, (_, i) => plain(i));

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const row = (lid: string) => pane.querySelector<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`)!;
  const dateOf = (lid: string) =>
    row(lid).querySelector<HTMLElement>('[data-pkc-field="updated"]')!.textContent ?? '';
  const s0: AppState = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: base(),
    relations: [],
  }).state;
  /** 一覧を差し替える(保存の ack と同じ ── 新しい Map、変わっていない件は同じ object)。 */
  const withMetas = (metas: EntryMeta[]): AppState => ({
    ...s0,
    entryMetas: new Map(metas.map((m) => [m.lid, m])),
  });
  return { render: (s: AppState) => browse.render(s, 'filer'), row, dateOf, withMetas, pane };
}

beforeEach(() => {
  document.body.textContent = '';
  titleReads = 0;
  updatedReads = 0;
});

describe('保存の ack で一覧の指紋を全件作り直さない(#1087)', () => {
  it('🔴 同じ日に 1 件の更新日時が動いても、全件の題名を読まず、行も字も変わらない', () => {
    const { render, row, dateOf, withMetas } = setup();
    const first = base().map(counted);
    render(withMetas(first));
    const before = dateOf('n5');
    const rows = first.map((m) => row(m.lid));
    expect(before, '前提: 日付の字が出ていない').not.toBe('');
    expect(titleReads, '前提: 最初の描画で全件の題名を読んでいない').toBeGreaterThanOrEqual(N);

    titleReads = 0;
    updatedReads = 0;
    const next = first.map((m) => (m.lid === 'n5' ? counted({ ...plain(5), updatedAt: `${YEAR}-01-02 09:09:09` }) : m));
    render(withMetas(next));

    expect(titleReads, '保存の ack で全件の題名を読み直している').toBeLessThan(20);
    // 日付の指紋は更新日時を読んで作る ── 全件作り直していれば件数に比例する
    expect(updatedReads, '保存の ack で全件の更新日時を読み直している').toBeLessThan(20);
    expect(dateOf('n5')).toBe(before);
    first.forEach((m, i) => expect(row(m.lid), `${m.lid} の行を作り直した`).toBe(rows[i]));
  });

  it('🔴 対照群: 日をまたいで日付の字が変わるときは、その行の字が新しくなる(前の答えを返さない)', () => {
    const { render, row, dateOf, withMetas } = setup();
    const first = base().map(counted);
    render(withMetas(first));
    const before = dateOf('n5');
    const other = dateOf('n6');
    const r6 = row('n6');

    const next = first.map((m) => (m.lid === 'n5' ? counted({ ...plain(5), updatedAt: `${YEAR}-01-03 09:09:09` }) : m));
    render(withMetas(next));

    expect(dateOf('n5'), '日付の字が古いまま').not.toBe(before);
    expect(dateOf('n6')).toBe(other);
    expect(row('n6'), '他の行を作り直した').toBe(r6);
  });

  it('🔴 対照群: 題名が変わったときは全件の指紋を作り直し、行の字が新しくなる', () => {
    const { render, row, withMetas } = setup();
    const first = base().map(counted);
    render(withMetas(first));
    titleReads = 0;
    const next = first.map((m) => (m.lid === 'n5' ? counted({ ...plain(5), title: '改名しました' }) : m));
    render(withMetas(next));
    expect(row('n5').textContent ?? '').toContain('改名しました');
    expect(titleReads, '題名が変わったのに全件を見直していない').toBeGreaterThanOrEqual(N);
  });
});
