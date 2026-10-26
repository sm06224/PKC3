/** @vitest-environment happy-dom */
/**
 * 🔴 **送り手が「押した時点の行の中身」を書換へ運ぶ**(#1087)。
 *
 * 書換(`task` / `line-date` / `repeat-*` / `csv-cell` / `task-run`)は、行番号に加えて
 * **押した時点の行の中身**(`openLine`)を持ち、disk 側の同じ行と byte 一致しなければ断る
 * (`tests/features/body-rewrite-open-line.test.ts`)。その中身を**運ぶのは押した面**である。
 *
 * ⚠ 面ごとに「いま見えている本文」の置き場が違う ── 取り違えると、古い表示から押した操作が
 *   **別の物を基準に**比べてしまう(比べる相手が違えば、ずれを見逃す / 正しい操作を断る):
 *
 * | 押した面 | 見えている物 | 口 |
 * |---|---|---|
 * | 本文・横に留めた枠 | `openBody` / `splitBodies` | `shownBodyLine` |
 * | 予定の札(押す・外す・刻み・掴む・戻す) | `taskScan.cards[].rawLine` | `shownCardLine` |
 * | 板の付箋の中のチェック | `placeBodies` | `shownPlacedLine` |
 *
 * 🔑 この file の主張:①各面が**その面の物**を運ぶ(本文を別の中身にして、札の値が出ることで見分ける)
 *   ②運べない(札が走査に居ない等)ときは**撃たずに断る**(`SHOWN_LINE_LOST`)③送り手の**全数**。
 *   ⚠ 本文の面(中央)の end-to-end は `center-pane.test.ts`、予定の札を掴む / 戻す経路は
 *   `schedule-drag.test.ts` / `schedule-grid-drag.test.ts` / `schedule-view.test.ts` が見る。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState, type UserAction } from '../../src/adapter/state/app-state';
import {
  SHOWN_LINE_LOST,
  shownBodyLine,
  shownCardLine,
  shownPlacedLine,
} from '../../src/adapter/state/shown-line';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { TaskCard } from '../../src/features/schedule/task-cards';

const meta = (lid: string): EntryMeta => ({
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
});

const CARD_LINE = '-  [ ]  見積を送る @2026-09-10'; // 字下げが特徴的な行(本文側と取り違えたら一致しない)
const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  lid: 'e1',
  line: 1,
  text: '見積を送る',
  done: false,
  date: '2026-09-10',
  time: null,
  timeEnd: null,
  until: null,
  repeat: null,
  substitutes: null,
  rawLine: CARD_LINE,
  ...over,
});

let root: HTMLElement;
let d: Dispatcher;
let sent: UserAction[];

/** 画面の本文(openBody)は札と**わざと違う中身**にする ── 取り違えを値で見分けるため。 */
const SHOWN_BODY = '# 題\n- [ ] 本文の側の行\n';

async function boot(cards: TaskCard[]): Promise<void> {
  root = document.createElement('div');
  document.body.append(root);
  d = new Dispatcher();
  bindActions(root, d, { settle: () => Promise.resolve() });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: SHOWN_BODY });
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  });
  sent = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: UserAction) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  await tick();
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** 予定の札の器(`task-card.ts` と同じ作り: article[data-pkc-entry] の中に印)。 */
function mountCard(opts: { repeat?: string; date?: string } = {}): HTMLInputElement {
  const el = document.createElement('article');
  el.setAttribute('data-pkc-entry', 'e1');
  if (opts.repeat !== undefined) {
    el.setAttribute('data-pkc-task-repeat', opts.repeat);
    el.setAttribute('data-pkc-task-date', opts.date ?? '2026-09-17');
  }
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('data-pkc-action', 'toggle-task');
  box.setAttribute('data-pkc-task-line', '1');
  if (opts.repeat !== undefined) {
    box.setAttribute('data-pkc-task-repeat', opts.repeat);
    box.setAttribute('data-pkc-task-date', opts.date ?? '2026-09-17');
  }
  const off = document.createElement('button');
  off.setAttribute('data-pkc-action', 'unschedule-task');
  el.append(box, off);
  root.append(el);
  return box;
}

const ofType = <T extends UserAction['type']>(t: T): Array<Extract<UserAction, { type: T }>> =>
  sent.filter((a): a is Extract<UserAction, { type: T }> => a.type === t);

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('予定の札を押す ── 札が焼かれた原文を運ぶ(本文の側ではない)', () => {
  it('🔴 チェックを押すと、札の `rawLine` が TOGGLE_TASK に載る', async () => {
    await boot([card()]);
    mountCard().click();
    await tick();
    const t = ofType('TOGGLE_TASK');
    expect(t, '撃たれていない').toHaveLength(1);
    // ⚠ 本文(openBody)の 1 行目は `- [ ] 本文の側の行` ── 取り違えたらここが違う字になる
    expect(t[0]!.openLine).toBe(CARD_LINE);
    expect(t[0]!.openLine).not.toBe('- [ ] 本文の側の行');
  });

  it('🔴 繰り返しの回を押すと、規則の行の原文が MATERIALIZE_REPEAT に載る', async () => {
    await boot([card({ repeat: 'week', rawLine: '- [ ] ゴミ出し @2026-09-10 毎週' })]);
    mountCard({ repeat: 'week' }).click();
    await tick();
    const m = ofType('MATERIALIZE_REPEAT');
    expect(m).toHaveLength(1);
    expect(m[0]!.openLine).toBe('- [ ] ゴミ出し @2026-09-10 毎週');
    expect(ofType('TOGGLE_TASK'), '繰り返しの回で規則の行の印を押した').toHaveLength(0);
  });

  it('🔴 札が走査に居なければ、撃たずに断る(運べない物を空で撃たない)', async () => {
    await boot([]);
    mountCard().click();
    await tick();
    expect(ofType('TOGGLE_TASK'), '運ぶ物が無いのに撃った').toHaveLength(0);
    expect(d.getState().error).toBe(SHOWN_LINE_LOST);
  });

  it('🔴 「予定から外す」も札の原文を運ぶ / 走査に居なければ断る', async () => {
    await boot([card()]);
    root.append(document.createElement('div'));
    const box = mountCard();
    (box.nextElementSibling as HTMLElement).click();
    await tick();
    const t = ofType('SET_TASK_DATE');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ lid: 'e1', line: 1, date: null, openLine: CARD_LINE });

    document.body.innerHTML = '';
    await boot([]);
    const box2 = mountCard();
    (box2.nextElementSibling as HTMLElement).click();
    await tick();
    expect(ofType('SET_TASK_DATE'), '運ぶ物が無いのに撃った').toHaveLength(0);
    expect(d.getState().error).toBe(SHOWN_LINE_LOST);
  });

  it('🔴 刻みを付け替えるボタンも札の原文を運ぶ / 走査に居なければ断る', async () => {
    const mountRepeatButton = (): HTMLElement => {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'set-task-repeat');
      b.setAttribute('data-pkc-entry', 'e1');
      b.setAttribute('data-pkc-task-line', '1');
      b.setAttribute('data-pkc-repeat', 'week');
      root.append(b);
      return b;
    };
    await boot([card()]);
    mountRepeatButton().click();
    await tick();
    const t = ofType('SET_TASK_REPEAT');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ lid: 'e1', line: 1, repeat: 'week', openLine: CARD_LINE });

    document.body.innerHTML = '';
    await boot([]);
    mountRepeatButton().click();
    await tick();
    expect(ofType('SET_TASK_REPEAT'), '運ぶ物が無いのに撃った').toHaveLength(0);
    expect(d.getState().error).toBe(SHOWN_LINE_LOST);
  });
});

describe('本文の面から押す ── 画面の本文の行を運ぶ(札の側ではない)', () => {
  it('🔴 リストをそろえる(task-run)は、運ばれた行番号ぶんの中身を並べて運ぶ', async () => {
    // 札は同じ行番号に別の中身を持つ ── 取り違えたらここが違う字になる
    await boot([card({ line: 1, rawLine: '- [ ] 札の側' })]);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'task-run-done');
    b.setAttribute('data-pkc-menu-lid', 'e1');
    b.setAttribute('data-pkc-menu-task-lines', '1');
    root.append(b);
    b.click();
    await tick();
    const r = ofType('SET_TASK_RUN');
    expect(r).toHaveLength(1);
    expect(r[0]!.openLines).toEqual(['- [ ] 本文の側の行']);
  });

  it('🔴 表の升は、欄を開いた時点の行の中身を運ぶ(確定は打った後でも、開いた時点の行)', async () => {
    await boot([card({ line: 1, rawLine: '- [ ] 札の側' })]);
    const td = document.createElement('td');
    td.setAttribute('data-pkc-action', 'edit-cell');
    td.setAttribute('data-pkc-cell-line', '1');
    td.setAttribute('data-pkc-cell-col', '0');
    td.setAttribute('data-pkc-cell-raw', 'a');
    td.textContent = 'a';
    root.append(td);
    td.click();
    const input = td.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');
    expect(input, '前提が崩れている(欄が開いていない)').not.toBeNull();
    // ⚠ 打っている間に画面の本文が替わっても、運ぶのは**開いた時点**の行
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '# 題\n別の行に替わった\n' });
    input!.value = 'b';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    const c = ofType('SET_CSV_CELL');
    expect(c, '確定が撃たれていない').toHaveLength(1);
    expect(c[0]).toMatchObject({ lid: 'e1', line: 1, col: 0, value: 'b', openLine: '- [ ] 本文の側の行' });
  });

  it('🔴 1 行でも画面の本文に無ければ、1 行も撃たずに断る(一部を空で運ぶと黙って飛ばされる)', async () => {
    await boot([card()]);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'task-run-done');
    b.setAttribute('data-pkc-menu-lid', 'e1');
    b.setAttribute('data-pkc-menu-task-lines', '1,99');
    root.append(b);
    b.click();
    await tick();
    expect(ofType('SET_TASK_RUN')).toHaveLength(0);
    expect(d.getState().error).toBe(SHOWN_LINE_LOST);
  });
});

describe('板の付箋の中のチェック ── 板のための抜粋の行を運ぶ', () => {
  const mountPlaced = (): HTMLInputElement => {
    const place = document.createElement('div');
    place.className = 'pkc-place';
    place.setAttribute('data-pkc-place-entry', 'e2');
    const slot = document.createElement('div');
    slot.setAttribute('data-pkc-field', 'place-body');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-pkc-action', 'toggle-task');
    // 原文の行番号(設定行 3 行 + 抜粋の 0 行目 = 3)
    box.setAttribute('data-pkc-task-line', '3');
    slot.append(box);
    place.append(slot);
    root.append(place);
    return box;
  };

  it('🔴 付箋のチェックは、置いたノート(e2)の抜粋の行を運ぶ ── 開いているノートの行ではない', async () => {
    await boot([card()]);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
    d.dispatch({ type: 'PLACE_BODY_LOADED', lid: 'e2', body: '---\ntitle: x\n---\n- [ ] 付箋の中の項目\n' });
    mountPlaced().click();
    await tick();
    const t = ofType('TOGGLE_TASK');
    expect(t).toHaveLength(1);
    // ⚠ 開いているノート(e1)の 3 行目は無い ── 取り違えたら null で断られて撃たれない
    expect(t[0]).toMatchObject({ lid: 'e2', line: 3, openLine: '- [ ] 付箋の中の項目' });
  });

  it('🔴 抜粋が届いていない付箋は、撃たずに断る', async () => {
    await boot([card()]);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
    mountPlaced().click();
    await tick();
    expect(ofType('TOGGLE_TASK')).toHaveLength(0);
    expect(d.getState().error).toBe(SHOWN_LINE_LOST);
  });
});

describe('口の実体(`shown-line.ts`)', () => {
  const base = (over: Partial<AppState>): AppState => ({ ...initialState, ...over });

  it('shownBodyLine ── 開いている本文と、横に留めた枠の本文(どちらも CRLF の復帰は落とす)', () => {
    const s = base({
      openBody: { lid: 'a', body: 'x\r\n- [ ] A\r\n', baseline: '', persisted: '', diskAhead: false },
      splitBodies: new Map([['b', '- [ ] B\n']]),
    });
    expect(shownBodyLine(s, 'a', 1)).toBe('- [ ] A');
    expect(shownBodyLine(s, 'b', 0)).toBe('- [ ] B');
    // 画面に出ていない lid / 範囲外は null(運び手は断る)
    expect(shownBodyLine(s, 'zzz', 0)).toBeNull();
    expect(shownBodyLine(s, 'a', 9)).toBeNull();
  });

  it('shownCardLine ── 走査の札の原文(lid と行の両方が合う札だけ)', () => {
    const s = base({
      taskScan: {
        cards: [card({ lid: 'a', line: 2, rawLine: '- [ ] A' }), card({ lid: 'b', line: 2, rawLine: '- [ ] B' })],
        totalNotes: 2,
        scannedNotes: 2,
        truncated: false,
      },
    });
    expect(shownCardLine(s, 'a', 2)).toBe('- [ ] A');
    expect(shownCardLine(s, 'b', 2)).toBe('- [ ] B');
    expect(shownCardLine(s, 'a', 3)).toBeNull();
    expect(shownCardLine(base({}), 'a', 2), '走査が無い').toBeNull();
  });

  it('shownPlacedLine ── 抜粋は設定行を剥がしてある(lineOffset を引く)/ 切った抜粋の最後の行は断る', () => {
    const ex = (text: string, over: Record<string, unknown> = {}) =>
      base({ placeBodies: new Map([['p', { text, cut: false, ...over }]]) });
    // 設定行 3 行(0..2)+ 本文 `- [ ] A` が原文の 3 行目
    expect(shownPlacedLine(ex('- [ ] A\n- [ ] B\n', { lineOffset: 3 }), 'p', 3)).toBe('- [ ] A');
    expect(shownPlacedLine(ex('- [ ] A\n- [ ] B\n', { lineOffset: 3 }), 'p', 4)).toBe('- [ ] B');
    // 設定行の中を指す番号は抜粋に無い
    expect(shownPlacedLine(ex('- [ ] A\n', { lineOffset: 3 }), 'p', 1)).toBeNull();
    // 切った抜粋: 最後の行は途中で割れているかもしれない ── 断る。手前の行は返す
    const cut = ex('- [ ] A\n- [ ] B', { cut: true });
    expect(shownPlacedLine(cut, 'p', 0)).toBe('- [ ] A');
    expect(shownPlacedLine(cut, 'p', 1), '切り口の行を返した').toBeNull();
    // 対照群: 切っていなければ最後の行も返す
    expect(shownPlacedLine(ex('- [ ] A\n- [ ] B'), 'p', 1)).toBe('- [ ] B');
    // 読めていない / 見出しが無い / 読み出しの失敗は null
    expect(shownPlacedLine(base({}), 'p', 0)).toBeNull();
    expect(shownPlacedLine(ex('', { missing: true }), 'p', 0)).toBeNull();
    expect(shownPlacedLine(ex('', { gone: true }), 'p', 0)).toBeNull();
  });
});

/**
 * 🔴 **送り手の全数**(#1087)。
 *
 * 書換の `openLine` / `openLines` は型で必須(運び忘れは tsc が落とす)だが、**型を迂回した撃ち方**
 * (`as UserAction`、スプレッドの上書き)は tsc を通る。ここは `src/` の撃ち口を数え、
 * 数が動いたら**運んでいるか見直す**ための pin である。
 * ⚠ 数を直すのは**送り手を足した / 消したときだけ**(その口が行の中身を運んでいることを確かめる)。
 */
describe('送り手の全数', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')
          ? [join(dir, e.name)]
          : [],
    );
  const files = walk(join(__dirname, '../../src/adapter/ui'));
  const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /** 撃ち口(`type: 'X'` を含むオブジェクト)のうち、運ぶ field を持たない物。 */
  const bare = (type: string, field: string): { count: number; missing: string[] } => {
    const missing: string[] = [];
    let count = 0;
    for (const f of files) {
      const src = codeOnly(readFileSync(f, 'utf8'));
      const re = new RegExp(`type:\\s*'${type}'`, 'g');
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        // 撃ち口の波括弧の中だけを見る(`{` から対応する `}` まで)
        const open = src.lastIndexOf('{', m.index);
        let depth = 0;
        let end = open;
        for (let i = open; i < src.length; i++) {
          if (src[i] === '{') depth++;
          if (src[i] === '}') depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
        const body = src.slice(open, end + 1);
        // 型の宣言(`type: 'X';`)ではなく撃ち口(`type: 'X',`)だけ数える
        if (!/type:\s*'[A-Z_]+',/.test(body.slice(m.index - open))) continue;
        count++;
        if (!new RegExp(`\\b${field}\\b`).test(body)) missing.push(`${f.split('/src/')[1]}: ${type}`);
      }
    }
    return { count, missing };
  };

  const EXPECT: Array<[string, string, number]> = [
    ['TOGGLE_TASK', 'openLine', 3], // 本文・留めた枠・付箋・札 / 付箋(binder の 2 口)/ 済みにした直後の「元に戻す」(schedule-undo、#1654)
    ['MATERIALIZE_REPEAT', 'openLine', 1],
    ['SET_TASK_RUN', 'openLines', 1],
    ['SET_CSV_CELL', 'openLine', 1],
    ['SET_CSV_SHAPE', 'openLine', 1], // 行・列の ＋ ×(binder の 1 口)
    ['SET_TABLE_FORMAT', 'openLine', 1], // 表の形変え(右クリックと ▾ の小窓は `applyTableFormat` の 1 口)
    // 一覧の行を本文へ落とす(binder)/ 落とした所へ入れる添付(asset-into-note)── どちらも落とした所の目印を運ぶ
    ['INSERT_LINES', 'anchor', 2],
    // 札を外す(binder)/ チェック項目の右クリック 今日・明日・外す(binder、#426 段②)/ 札を日へ落とす(schedule-drag)/ 繰り返しを全部ずらす(同)/ 目盛りで動かす(grid-drag)/ 戻す(undo)
    ['SET_TASK_DATE', 'openLine', 6],
    ['SET_TASK_REPEAT', 'openLine', 1],
    ['MOVE_REPEAT_OCCURRENCE', 'openLine', 1],
  ];

  for (const [type, field, n] of EXPECT) {
    it(`${type} の撃ち口は ${String(n)} か所で、全部が ${field} を運ぶ`, () => {
      const r = bare(type, field);
      expect(r.missing, `${field} を運ばない撃ち口`).toEqual([]);
      expect(r.count, '撃ち口の数が動いた(足した / 消したなら、その口が行の中身を運ぶことを確かめて数を直す)').toBe(n);
    });
  }
});
