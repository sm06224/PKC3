/** @vitest-environment happy-dom */
/**
 * 🔴 **こちらが開いた追記欄は、送ったら元どおり畳む ── user の畳みの記録には書かない**
 * (#655 ①。user 裁定 2026-09-04 案 B)。
 *
 * ## 物語
 *
 * 「閲覧メインだから」と追記欄を畳んでいる人が、本文を読んでいて **`Alt`+クリック**
 * (= 「ここに追記する」)を押す。欄が開いて 1 行足せる ── ここまでは #596。
 * ⚠ 直す前はその「開く」が `setHidden` だったので、**user が自分で畳んだ設定を
 * こちらが黙って上書きして永続**していた。1 行足したいだけだったのに、次に開いても
 * 追記欄が出ている(戻すには帯をもう一度押す ── そして押した人は「なぜ開いていたのか」
 * を知る手立てが無い)。
 *
 * ## 守る主張
 *
 * 1. 🔴 開いても `localStorage['pkc3.panes']` に **1 度も書かない**
 * 2. 🔴 追記を**送り終えたら**畳み直す(記録は書かない)
 * 3. 🔴 欄の外で **1 操作**したら畳み直す ── そのとき別のペインを畳んでも、
 *    追記欄の畳みは記録に残る
 * 4. ⚠ 打ちかけが在る間は畳まない(「押したら消えた」を作らない)
 * 5. 対照群 ── user が自分で開いていた欄は、送っても畳まない
 *
 * ⚠ **直す前の実装で赤くなること**を 1 と 2 で確かめてある(1: `setHidden` は書く /
 *   2: 畳み直す者が居ない)── CLAUDE.md §1 末尾「両方で緑なら守っていない」。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { encodeHidden } from '../../src/features/pane-visibility';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

const KEY = 'pkc3.panes';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 見出し 2 つの本文。⚠ 刻印の行番号は本文の行と揃える。 */
const BODY = ['# 上の節', '', 'a', '', '## 決定事項', '', 'b', ''].join('\n');
const HTML = [
  '<h1 data-pkc-source-line="0">上の節</h1>',
  '<p data-pkc-source-line="2" id="pa">a</p>',
  '<h2 data-pkc-source-line="4">決定事項</h2>',
  '<p data-pkc-source-line="6" id="pb">b</p>',
].join('');

beforeEach(() => {
  document.body.textContent = '';
  localStorage.clear();
});

afterEach(() => {
  // ⚠ 一時表示は module 共有の 1 個に残る ── 次の file / test へ持ち越さない
  appPanes.unpeek();
  appPanes.setHidden([]);
  vi.restoreAllMocks();
});

/**
 * 実 UI 一式(shell / 追記欄の描画器 / binder / 効果層)。⚠ 読む面は**本物と同じ刻印**
 * (`data-pkc-source-line`)で組む ── 別の名前で組むと、この test だけ通って実物では効かない。
 */
async function setup(folded: boolean) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = HTML;
  regions.detail.append(host);
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => box.render(s));
  bindActions(root, d);
  const disk: Record<string, string> = { n1: BODY };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  // 🔑 user の畳み ── **記録に書く**のはここだけ(user 自身の操作に相当する)
  appPanes.setHidden(folded ? ['append'] : []);
  applyPaneVisibility(root, appPanes.getHidden());
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
  expect(d.getState().openBody?.lid, '前提: 本文が届いていない').toBe('n1');
  /**
   * 🔴 **記録への書込を数える**。⚠ 値の前後比較では足りない ── 同じ値を書き戻しても
   *   「書いた」であり、直す前の実装はまさに**同じ鍵へ書いて**いた。
   */
  const writes = vi.spyOn(localStorage, 'setItem');
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  const input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
  const altClick = (id: string): void => {
    root
      .querySelector(`#${id}`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
  };
  const press = (sel: string): void => root.querySelector<HTMLElement>(sel)!.click();
  const hiddenAttr = (): string => shell.getAttribute('data-pkc-hidden-panes') ?? '';
  return { root, d, disk, shell, input, writes, altClick, press, hiddenAttr };
}

describe('こちらが開いた追記欄は、送ったら畳み直す(#655 ①)', () => {
  it('🔴 Alt+クリックで開いても、user の畳みの記録には 1 度も書かない', async () => {
    const r = await setup(true);
    expect(r.hiddenAttr(), '前提: 畳まれていない').toContain('append');
    r.altClick('pb');
    expect(r.hiddenAttr(), '開いていない').not.toContain('append');
    expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(r.input);
    expect(r.d.getState().notice ?? '', '畳み直すことを言っていない').toContain(
      '送ると元どおり畳みます',
    );
    // 🔴 記録は 1 byte も動いていない(書き戻しすらしていない)
    expect(r.writes, '記録に書いた').not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe('append');
    // ⚠ 見せているだけなので、記録を読み直しても畳んだまま(次の起動で元どおり)
    expect(appPanes.isPeeking()).toBe(true);
  });

  it('🔴 送り終えたら元どおり畳む ── 記録は書かない', async () => {
    const r = await setup(true);
    r.altClick('pb');
    r.input.value = '足した 1 行';
    r.press('[data-pkc-action="append-entry"]');
    await tick(40);
    // ⚠ 前提: 追記が本当に通っている(通っていなければ「畳まれていない」を検めていない)
    expect(r.disk.n1, '前提: 追記が届いていない').toContain('足した 1 行');
    expect(r.hiddenAttr(), '送ったのに畳み直していない').toContain('append');
    expect(r.input.value, '通ったのに欄が空になっていない').toBe('');
    expect(appPanes.isPeeking()).toBe(false);
    expect(r.writes, '畳み直すときに記録へ書いた').not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe('append');
  });

  it('⚠ 断られた送り(空のまま押す)では畳まない ── 欄は出したまま', async () => {
    const r = await setup(true);
    r.altClick('pb');
    r.press('[data-pkc-action="append-entry"]');
    await tick();
    expect(r.disk.n1, '前提: 空の追記が本文を変えた').toBe(BODY);
    expect(r.hiddenAttr(), '断られたのに畳んだ(打つ所が消える)').not.toContain('append');
  });

  /**
   * 🔴 **欄の外で 1 操作したら畳み直す** ── その操作が別のペインの畳みでも、
   *   **追記欄の畳みは記録に残る**(`getHidden()` から組んだ一覧をそのまま記録すると、
   *   右を 1 回畳んだだけで追記欄の畳みが記録から消える)。
   */
  it('🔴 欄の外で 1 操作すると畳み直す ── 別のペインを畳んでも追記欄の畳みは記録に残る', async () => {
    const r = await setup(true);
    r.altClick('pb');
    expect(r.hiddenAttr()).not.toContain('append');
    r.press('[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]');
    expect(r.hiddenAttr(), '欄の外で操作したのに畳み直していない').toContain('append');
    expect(r.hiddenAttr(), '押した右の列が畳まれていない').toContain('inspector');
    // 🔑 user の操作(右を畳む)は記録に書く ── そのとき追記欄の畳みを落とさない
    expect(localStorage.getItem(KEY)).toBe(encodeHidden(['inspector', 'append']));
    expect(appPanes.isPeeking()).toBe(false);
  });

  it('⚠ 打ちかけが在る間は、欄の外の操作でも畳まない(「押したら消えた」を作らない)', async () => {
    const r = await setup(true);
    r.altClick('pb');
    r.input.value = '下書き';
    r.press('[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]');
    expect(r.hiddenAttr(), '右の列は畳まれる').toContain('inspector');
    expect(r.hiddenAttr(), '打ちかけが在るのに畳んだ').not.toContain('append');
    expect(r.input.value, '打ちかけが消えた').toBe('下書き');
  });

  it('🔴 帯を押して自分で畳んだら、それは記録に書く(見せているだけの状態が終わる)', async () => {
    const r = await setup(true);
    r.altClick('pb');
    r.writes.mockClear();
    r.press('[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
    expect(r.hiddenAttr(), '帯を押したのに畳まれていない').toContain('append');
    expect(appPanes.isPeeking()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('append');
  });

  it('対照群 ── user が自分で開いていた欄は、送っても畳まない', async () => {
    const r = await setup(false);
    r.altClick('pb');
    expect(r.d.getState().notice ?? '', '開いていないのに開いたと言った').not.toContain(
      '追記欄を開きました',
    );
    r.input.value = '足した 1 行';
    r.press('[data-pkc-action="append-entry"]');
    await tick(40);
    expect(r.disk.n1, '前提: 追記が届いていない').toContain('足した 1 行');
    expect(r.hiddenAttr(), '自分で開いていた欄を畳んだ').not.toContain('append');
    expect(r.writes).not.toHaveBeenCalled();
  });
});
