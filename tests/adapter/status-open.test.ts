/** @vitest-environment happy-dom */
/**
 * 🔴 **知らせの隣の「開く」**(#668 A。PR #667 の着地前レビュー)。
 *
 * 添付を取り込んだのに本文へ入れられなかった回(開いているのがフォルダ等)は、
 * 「「見積.pdf」を添付にしました(…本文には入れていません)」と言う ── そのとき
 * **その添付へ行く道が画面のどこにも無かった**。この file が守るのは:
 *
 * ① 🔴 器(`shell.ts`)が押し口を持ち、それが **`select-entry` の受け手**へ繋がっている
 *    (実行の口を新しく作らない ── §7)
 * ② 🔴 身元が在れば出て、`data-pkc-entry` に**その lid**が書かれる
 * ③ 🔴 畳む 3 条件 ── 身元が無い / もう開いている / 字が別の知らせに上書きされた
 *
 * ⚠ `main.ts` の配線(`paintOpen`)は test から届かない ── だから判断はここに在る
 *   (CLAUDE.md §2「どの test からも実行されない file に、判断を書かない」)。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  paintStatusCreate,
  paintStatusOpen,
  paintStatusRescue,
  paintStatusUndo,
} from '../../src/adapter/ui/render/status-open';
import { CORRUPT_REFUSAL, corruptReport } from '../../src/features/storage/db-corruption';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const LINE = '「見積.pdf」を添付にしました(開いているのは『フォルダ』なので、本文には入れていません)';

function btn(): HTMLElement {
  const b = document.createElement('button');
  b.hidden = true;
  return b;
}

describe('知らせの隣の「開く」(#668 A)', () => {
  it('🔴 ① 器が押し口を持ち、select-entry の受け手へ繋がっている', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const open = regions.statusOpen;
    expect(open.getAttribute('data-pkc-field')).toBe('status-open');
    // 🔑 実行の口は既存の受け手 ── ここが別の名前なら、押しても誰も拾わない
    // 🔴 #809-4 で `swap-open` へ ── 行き先が枠に居るときは**入れ替える**
    //    (枠に居ないときは reducer が素の `SELECT_ENTRY` へ落とす)
    expect(open.getAttribute('data-pkc-action'), '受け手の無い口').toBe('swap-open');
    expect(open.textContent).toBe('そのノートを開く');
    expect(open.hidden, '身元が無いのに出ている').toBe(true);
    // ⚠ 状態の行の**中**に居る(知らせの隣に出る)
    expect(regions.status.contains(open), '状態の行の外に居る').toBe(true);
  });

  it('🔴 ② 身元が在れば出て、その lid を受け手が読む属性に書く', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('data-pkc-entry'), '押しても別の物が開く').toBe('a1');
  });

  it('⚠ ③ 身元が無ければ畳む(添えない知らせに押す口を残さない)', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    paintStatusOpen(b, { noticeOpen: null, selectedLid: 'f1', notice: 'コピーしました' }, 'コピーしました');
    expect(b.hidden).toBe(true);
    expect(b.hasAttribute('data-pkc-entry'), '古い身元が残っている').toBe(false);
  });

  it('🔴 ③ もうそれを開いていたら畳む(開いている物を「開く」と言わない)', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'a1', notice: LINE }, LINE);
    expect(b.hidden, '開いている物の「開く」が出ている').toBe(true);
  });

  it('🔴 ③ 字が別の知らせ(state を通らない showStatus)に上書きされたら畳む', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    expect(b.hidden, '前提: 出ていない').toBe(false);
    // 「コピーしました」が字だけ上書きした ── state の notice は古いまま残る
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, 'コピーしました');
    expect(b.hidden, '別の知らせの隣に、前の添付の「開く」が残っている').toBe(true);
  });
});

/**
 * 🔴 **知らせの隣の「元に戻す」が、開いていないノートへ足した行も戻す**
 * (#684 ㋑、着地前の動線レビュー 欠陥 3・4・6)。
 *
 * ## 直す前に何が起きていたか
 *
 * 追記欄の「元に戻す」は **`lastAppend.lid === selectedLid`** のときだけ出る
 * (`append-box.ts`)。だから**横に留めた枠へ入れた行**は、そのノートを中央へ
 * 開くまで戻せず、⚠ 開くと**読んでいた本文が中央から消える** ── 戻すために
 * 主の作業領域を明け渡すことになっていた(#300 と同じ形)。
 *
 * ## 守る主張
 *
 * ① 🔴 行き先(`noticeOpen`)と材料(`lastAppend.lid`)が**同じノート**なら出る
 * ② 🔴 押し先が **`undo-append`** に切り替わる(塊の取り消しと同じ器・別の受け手)
 * ③ ⚠ 塊の移動が先で、両方の条件が立っても**塊の側が勝つ**(字と押し先が揃う)
 * ④ ⚠ 字が別の知らせに上書きされたら畳む(「開く」と同じ作法)
 * ⑤ ⚠ 材料が**別のノート**を指していたら出ない(押すと画面に無い物が戻る)
 */
describe('知らせの隣の「元に戻す」── 開いていないノートの行(#684 ㋑)', () => {
  const PUT = '「猫.png」を『さきの予定』のドロップした所に入れました';
  const undoBtn = (): HTMLElement => {
    const b = document.createElement('button');
    b.hidden = true;
    b.setAttribute('data-pkc-action', 'undo-move');
    return b;
  };

  it('🔴 ① ② 行き先と材料が同じノートなら出て、undo-append へ繋がる', () => {
    const b = undoBtn();
    paintStatusUndo(b, { lastMove: null, notice: PUT, lastAppend: { lid: 'n2' }, noticeOpen: 'n2' }, PUT);
    expect(b.hidden, '戻す口が出ない(片道になっている)').toBe(false);
    expect(b.getAttribute('data-pkc-action'), '押すと別の物が戻る').toBe('undo-append');
    // 🔴 #1046: 器を共有するので、字も対象に合わせて切り替わっていること
    //    (字だけ「移動を元に戻す」で固定されると、起きることと違う字になる)
    expect(b.textContent, '追記を戻すのに移動の字が出ている').toBe('追記を元に戻す');
  });

  it('🔴 ③ 塊を動かした知らせでは、これまでどおり undo-move が勝つ', () => {
    const b = undoBtn();
    const MOVED = '本文のブロックを動かしました';
    // ⚠ 材料が両方在る形で見る(片方しか無い台では、どちらが勝つかを見ていない)
    paintStatusUndo(b, { lastMove: {}, notice: MOVED, lastAppend: { lid: 'n2' }, noticeOpen: 'n2' }, MOVED);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('data-pkc-action'), '塊の知らせなのに追記が戻る').toBe('undo-move');
    expect(b.textContent, '移動を戻すのに追記の字が出ている').toBe('移動を元に戻す');
  });

  it('🔴 ⑤ 材料が別のノートを指していたら出ない', () => {
    const b = undoBtn();
    paintStatusUndo(b, { lastMove: null, notice: PUT, lastAppend: { lid: 'n9' }, noticeOpen: 'n2' }, PUT);
    expect(b.hidden, '画面に出ていない別のノートの行が戻る口を出した').toBe(true);
  });

  it('⚠ ④ 字が別の知らせに上書きされたら畳む', () => {
    const b = undoBtn();
    paintStatusUndo(b, { lastMove: null, notice: PUT, lastAppend: { lid: 'n2' }, noticeOpen: 'n2' }, PUT);
    expect(b.hidden, '前提: 出ている').toBe(false);
    paintStatusUndo(
      b,
      { lastMove: null, notice: PUT, lastAppend: { lid: 'n2' }, noticeOpen: 'n2' },
      'コピーしました',
    );
    expect(b.hidden, '別の知らせの隣に残っている(押すと別の物が戻る)').toBe(true);
  });

  it('⚠ 材料が無ければ出ない(押しても何も起きない口を出さない)', () => {
    const b = undoBtn();
    paintStatusUndo(b, { lastMove: null, notice: PUT, lastAppend: null, noticeOpen: 'n2' }, PUT);
    expect(b.hidden).toBe(true);
  });
});

/**
 * 🔴 **本文の `@日付` を押したがノートが無かったときの「○○のノートを作る」**(#1169)。
 *
 * 畳む 3 条件は「開く」と同じ作法 ── 日付が無い / 出ている字が「まだありません」でない /
 * 読む画面でない(編集中に出しても押せば断られるだけ)。
 */
describe('知らせの隣の「○○のノートを作る」(#1169)', () => {
  const MISSING = '2026-10-15 のノートはまだありません';
  const ready = { noticeCreate: '2026-10-15', notice: MISSING, phase: 'ready' } as const;

  it('🔴 器が押し口を持ち、create-date-note の受け手へ繋がっている', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const b = regions.statusCreate;
    expect(b.getAttribute('data-pkc-field')).toBe('status-create-date');
    expect(b.getAttribute('data-pkc-action'), '受け手の無い口').toBe('create-date-note');
    expect(b.hidden, '日付が無いのに出ている').toBe(true);
    expect(regions.status.contains(b), '状態の行の外に居る').toBe(true);
  });

  it('🔴 条件が揃えば、日付と字を書いて出す', () => {
    const b = btn();
    paintStatusCreate(b, ready, MISSING);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('data-pkc-date'), '受け手が読む属性に日付が無い').toBe('2026-10-15');
    expect(b.textContent).toBe('2026-10-15 のノートを作る');
  });

  it('🔴 別の日付の知らせに替われば、字も日付も追従する(前の日付を残さない)', () => {
    const b = btn();
    paintStatusCreate(b, ready, MISSING);
    const next = '2026-10-16 のノートはまだありません';
    paintStatusCreate(b, { noticeCreate: '2026-10-16', notice: next, phase: 'ready' }, next);
    expect(b.getAttribute('data-pkc-date')).toBe('2026-10-16');
    expect(b.textContent).toBe('2026-10-16 のノートを作る');
  });

  it('🔴 畳む条件 ── 日付が無い / 字が上書きされた / 読む画面でない', () => {
    const shown = (): HTMLElement => {
      const b = btn();
      paintStatusCreate(b, ready, MISSING);
      expect(b.hidden, '前提: 出ていない').toBe(false);
      return b;
    };
    let b = shown();
    paintStatusCreate(b, { ...ready, noticeCreate: null }, MISSING);
    expect(b.hidden, '日付が無いのに残っている').toBe(true);
    expect(b.hasAttribute('data-pkc-date'), '畳んだのに日付が残っている').toBe(false);

    // 🔴 状態の行だけが別の字に上書きされた(コピーした等)── state の知らせは動かない
    b = shown();
    paintStatusCreate(b, ready, 'コピーしました');
    expect(b.hidden, '上書きされた後も残っている(押すと「コピー」の続きに見える)').toBe(true);

    // 🔴 state の知らせが別の物に替わった(日付だけ残っている)
    b = shown();
    paintStatusCreate(b, { ...ready, notice: 'コピーしました' }, 'コピーしました');
    expect(b.hidden, '別の知らせの隣に前の日付が残っている').toBe(true);

    // 🔴 編集中は出さない(`CREATE_ENTRY` は編集中に通らない)
    b = shown();
    paintStatusCreate(b, { ...ready, phase: 'editing' }, MISSING);
    expect(b.hidden, '編集中に出ている(押しても断られるだけ)').toBe(true);
  });
});

/**
 * 🔴 **保存が止まった断り書きの隣の「ノートの保存データの確認を開く」**(#1010 B)。
 *
 * 断り書きは「システム の 保存領域 の「保存領域の点検」で…」と道順を言うのに、
 * **押しても設定へ飛ばなかった**。守るのは:
 * ① 器が押し口を持ち、受け手 `open-storage-check` へ繋がっている
 * ② **断り書きが出ている間だけ**出る(別の知らせが上書きしたら畳む ── 対照群つき)
 * ③ 🔴 **押すと「システム」が開き、点検の節へ送られる**(押した場所と効く先を対で)
 *
 * ⚠ ②の「出す条件」は `main.ts` から届かないので判断はここ(`status-open.ts`)に在る。
 */
describe('保存が止まった断り書きの隣の「ノートの保存データの確認を開く」(#1010 B)', () => {
  afterEach(() => {
    document.body.textContent = '';
  });

  it('🔴 ① 器が押し口を持ち、受け手へ繋がっている(最初は畳んである)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const b = regions.statusRescue;
    expect(b.getAttribute('data-pkc-action'), '受け手の無い口').toBe('open-storage-check');
    expect(b.textContent).toBe('ノートの保存データの確認を開く');
    expect(b.hidden, '断り書きが無いのに出ている').toBe(true);
    expect(regions.status.contains(b), '状態の行の外に居る').toBe(true);
  });

  it('🔴 ② 断り書きが出ている間だけ出る(前置き・後ろの「で検出」付きでも)', () => {
    const b = btn();
    paintStatusRescue(b, `⚠ エラー: ${CORRUPT_REFUSAL}`);
    expect(b.hidden, '断り書きの隣に出ていない').toBe(false);
    paintStatusRescue(b, `⚠ エラー: Error: ${corruptReport('upsertEntry', 'SQLITE_CORRUPT')}`);
    expect(b.hidden, '「で検出」付きの断り書きで畳んでいる').toBe(false);
    // 対照群 ── 別の知らせが上書きしたら畳む(「コピーしました」の隣に残さない)
    paintStatusRescue(b, 'コピーしました');
    expect(b.hidden, '別の知らせの隣に残っている').toBe(true);
    // 対照群 ── 似た字の別のエラーでは出さない
    paintStatusRescue(b, '⚠ エラー: 保存されている中身を読み込めませんでした');
    expect(b.hidden, '別のエラーに点検の入口を出した').toBe(true);
    paintStatusRescue(b, '');
    expect(b.hidden).toBe(true);
  });

  /**
   * ⚠ **弱い pin である**(CLAUDE.md §2「どの test からも実行されない file」)── `main.ts` は
   *   test から実行されないので、配線(状態の行を塗るたびに押し口へ字を渡す)は**原文で見る**。
   *   見るのは**実行する行**(注釈の行は除く)。①〜③ は押し口の判断と受け手を見ている。
   */
  it('⚠ ④ main.ts が、状態の行へ出した字をそのまま押し口へ渡している(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toContain('paintStatusRescue(regions.statusRescue, text);');
  });

  it('🔴 ③ 押すと「システム」が開き、「保存領域の点検」の節へ送られる', async () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    try {
      const root = document.createElement('div');
      document.body.append(root);
      const d = new Dispatcher();
      const regions = buildShell(root);
      const center = new CenterRouter(regions.detail, () => new Date(2026, 9, 1));
      d.onState((st) => center.render(st));
      bindActions(root, d);
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
      expect(d.getState().viewMode, '前提: 設定はまだ開いていない').not.toBe('settings');

      // 実 UI と同じ ── 器の押し口を出して押す
      regions.statusRescue.hidden = false;
      regions.statusRescue.click();

      expect(d.getState().viewMode, '押しても「システム」が開かない').toBe('settings');
      const target = scrolled.find((el) => el.getAttribute('data-pkc-region') === 'db-rescue');
      expect(target, '点検の節へ送られていない').toBeDefined();
      expect(root.contains(target!), '送った先が画面の外の要素').toBe(true);
      // 対照群 ── 目次の「上へ」のように別の節へ送っていない
      expect(scrolled.every((el) => el === target), '点検の節以外へも送っている').toBe(true);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
