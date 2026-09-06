/** @vitest-environment happy-dom */
/**
 * 🔴 **表の升の入力欄を、塊の差し替えを跨いで生かす**(#745)。
 *
 * ⚠ 本体の物語は実ブラウザの smoke が見る(`tests/smoke/md-table-cell.smoke.spec.ts`)──
 *   欄を殺すのは `applyBlocks` の塊の差し替えで、それは実物の描画経路でしか走らない。
 * 🔑 ここが見るのは、smoke では**条件を作りにくい 1 つ**である:
 *   **行がずれた回に、別の升へ開き直さないか**。
 *
 * ⚠ `reopenCellInput` は `cell.click()` を撃つだけで、欄を組むのは `binder.ts` である
 *   (§7:口を 2 つ作らない)。だから台は**その binder の代わり**を置く ──
 *   ⚠ 代わりは**本物と同じ作法**にする(`data-pkc-field="cell-input"` を付け、
 *   升の字を欄の初期値にする)。甘くすると、本物では起きない緑が出る(CLAUDE.md §3)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureCellInput,
  HOLD_ATTR,
  neighborCell,
  openCellAt,
  reopenCellInput,
  requestCellMove,
  takeCellMove,
} from '../../src/adapter/ui/render/cell-input';

/** 升 1 つ。⚠ 属性の綴りは**実物の発行口と同じ**(`csv-table.ts` / `markdown-render.ts`)。 */
function cell(line: number, col: number, raw: string): HTMLElement {
  const td = document.createElement('td');
  td.setAttribute('data-pkc-action', 'edit-cell');
  td.setAttribute('data-pkc-cell-line', String(line));
  td.setAttribute('data-pkc-cell-col', String(col));
  td.setAttribute('data-pkc-cell-raw', raw);
  td.textContent = raw;
  return td;
}

/** 升を並べた器。⚠ `binder.ts` の代わりに、押されたら欄を作る口を付ける。 */
function host(cells: readonly [number, number, string][]): HTMLElement {
  const h = document.createElement('div');
  for (const [line, col, raw] of cells) {
    const td = cell(line, col, raw);
    td.addEventListener('click', () => {
      // ⚠ 本物と同じ ── 升の字を初期値にして、全部選ぶ
      const input = document.createElement('input');
      input.setAttribute('data-pkc-field', 'cell-input');
      input.value = td.getAttribute('data-pkc-cell-raw') ?? '';
      td.replaceChildren(input);
    });
    h.append(td);
  }
  document.body.replaceChildren(h);
  return h;
}

/** その器で開いている欄(無ければ `null`)。 */
const openInput = (h: HTMLElement): HTMLInputElement | null =>
  h.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');

/** 升を押して、打ちかけの字を入れる。 */
function typeInto(h: HTMLElement, nth: number, value: string): HTMLInputElement {
  const td = [...h.querySelectorAll<HTMLElement>('[data-pkc-action="edit-cell"]')][nth]!;
  td.click();
  const input = openInput(h)!;
  input.value = value;
  // ⚠ 字を打った後は末尾に caret が在る(happy-dom は `value` を入れても動かさない)
  input.setSelectionRange(value.length, value.length);
  return input;
}

describe('升の欄を控える(#745)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('🔴 控えると、確定しない印が付く(`blur` で本文へ書かせない)', () => {
    const h = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    const input = typeInto(h, 1, 'りんご');
    expect(input.hasAttribute(HOLD_ATTR), '控える前から印が付いている').toBe(false);
    const keep = captureCellInput(h);
    expect(keep, '開いている欄を控えられていない').not.toBeNull();
    expect(input.hasAttribute(HOLD_ATTR), '確定しない印が付いていない').toBe(true);
    // 🔑 控えるのは**位置・打ちかけの字・升の字**の 4 つ
    expect(keep).toEqual({ line: '2', col: '1', raw: '2', value: 'りんご', start: 3, end: 3 });
  });

  it('⚠ 欄が開いていなければ `null`(何も控えない)', () => {
    expect(captureCellInput(host([[2, 0, '1']]))).toBeNull();
  });
});

describe('升の欄を開き直す(#745)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /** 塊が差し替わった後の器(升の中身が新しくなり、欄は消えている)。 */
  const rebuilt = (cells: readonly [number, number, string][]): HTMLElement => host(cells);

  it('🔴 同じ升なら、打ちかけの字と字を打つ位置ごと開き直す', () => {
    const before = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    const input = typeInto(before, 1, 'りんご');
    input.setSelectionRange(2, 2);
    const keep = captureCellInput(before)!;

    // 塊の差し替え ── 隣の升だけ新しくなった(いま打っている升は同じ字のまま)
    const after = rebuilt([
      [2, 0, 'あ'],
      [2, 1, '2'],
    ]);
    reopenCellInput(after, keep);

    const now = openInput(after);
    expect(now, '開き直していない').not.toBeNull();
    expect(now!.value, '打ちかけの字が戻っていない').toBe('りんご');
    expect([now!.selectionStart, now!.selectionEnd], '字を打つ位置が戻っていない').toEqual([2, 2]);
    // 🔑 開いたのは**その升**である(隣ではない)
    expect(now!.closest('[data-pkc-action="edit-cell"]')?.getAttribute('data-pkc-cell-col')).toBe(
      '1',
    );
  });

  /**
   * 🔴 **行がずれた回は開かない**(動線レビュー D3。変異 E3)。
   *
   * ⚠ 行番号は**掴んだ時点のもの**なので、本文に 1 行入ると番号が全部ずれる ──
   *   番号 2 を持つのは、**さっきまで番号 1 だった升**である。
   * 🔑 そこへ開き直すと、打った字が**別の行**に入る。画面は「打っている升」に
   *   見えているので、間違いに気づく手掛かりが 1 つも無い。
   */
  it('🔴 同じ番号でも、升の字が違えば開かない(別の行へ字を移さない)', () => {
    const before = host([
      [2, 0, 'りんご'],
      [2, 1, '3'],
    ]);
    typeInto(before, 1, '5');
    const keep = captureCellInput(before)!;

    // ⚠ 本文に 1 行入った ── 番号 2 を持つのは、さっきまで番号 1 だった行である
    const after = rebuilt([
      [2, 0, 'みかん'],
      [2, 1, '12'],
    ]);
    reopenCellInput(after, keep);

    expect(openInput(after), '別の行の升へ開き直した(打った字が移る)').toBeNull();
    // ⚠ 空振り防止 ── 升の字が同じなら開く(門が広すぎない)
    const same = rebuilt([
      [2, 0, 'りんご'],
      [2, 1, '3'],
    ]);
    reopenCellInput(same, keep);
    expect(openInput(same), '同じ升にも開かない(門が広すぎる)').not.toBeNull();
  });

  it('⚠ その升が消えていれば、何もしない', () => {
    const before = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    typeInto(before, 1, 'りんご');
    const keep = captureCellInput(before)!;
    const after = rebuilt([[2, 0, '1']]); // 列が減った
    reopenCellInput(after, keep);
    expect(openInput(after), '無い升へ開き直した').toBeNull();
  });

  it('⚠ 既に欄が開いていれば、二重に開かない', () => {
    const h = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    const input = typeInto(h, 1, 'りんご');
    const keep = captureCellInput(h)!;
    reopenCellInput(h, keep);
    expect(h.querySelectorAll('[data-pkc-field="cell-input"]'), '欄が 2 つ出た').toHaveLength(1);
    expect(openInput(h), '同じ欄が入れ替わった').toBe(input);
  });
});

/**
 * 🔴 **着地前レビューが実測で拾った 3 件**(#745 の 3 巡目)。
 * ⚠ どれも**私が入れた退行**か、**私が「守れない」と書き誤った**ものである。
 */
describe('#745 着地前レビューの指摘', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /**
   * 🔴 **印が残ると、`Enter` を押しても何も起きない**(レビュー W-1)。
   *
   * ⚠ 塊が差し替わらなかった回(= 表と関係ない書き戻し ── 末尾への追記など)は
   *   **同じ欄が生き残る**ので、印を消さないとそのまま残る。`commit()` は印を見て
   *   黙って帰るので、**打った字が本文に入らない**。
   * 🔑 #748 が直した「押せるのに書けない」と同じ顔で、今度は**字が消える側**である。
   */
  it('🔴 塊が差し替わらなかった回は、確定しない印を残さない', () => {
    const h = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    const input = typeInto(h, 1, 'りんご');
    const keep = captureCellInput(h)!;
    expect(input.hasAttribute(HOLD_ATTR), '前提が崩れた(印が付いていない)').toBe(true);

    // ⚠ 表と関係ない書き戻し ── 塊は差し替わらず、欄はそのまま生きている
    reopenCellInput(h, keep);

    expect(openInput(h), '欄が入れ替わった').toBe(input);
    expect(input.hasAttribute(HOLD_ATTR), '確定しない印が残った(Enter が効かなくなる)').toBe(
      false,
    );
  });

  /**
   * 🔴 **字を打つ位置を戻さないと、次の 1 打で打ちかけの字が全部消える**
   *   (レビュー A-1。⚠ 私は「殺せない」と書いていたが**誤り**だった)。
   *
   * ⚠ 欄を開くと `binder.ts` が `select()` で**全部選ぶ**。戻さないとその全選択が
   *   残るので、次の 1 字が打ちかけの字を丸ごと置き換える。
   * 🔑 だから見るのは**caret を字の途中に置いた**形である ── 末尾に置いた台では
   *   全選択と見分けがつかない(2026-09-06 に、まさにそれで見落とした)。
   */
  it('🔴 字の途中に caret を置いていたら、その位置ごと戻る', () => {
    const before = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    const input = typeInto(before, 1, 'いう');
    input.setSelectionRange(1, 1); // ⚠ `い` と `う` の間
    const keep = captureCellInput(before)!;

    const after = host([
      [2, 0, 'あ'],
      [2, 1, '2'],
    ]);
    reopenCellInput(after, keep);

    const now = openInput(after)!;
    // 🔑 **全選択のままでないこと**を見る ── ここが全選択だと、次の 1 打で全部消える
    expect([now.selectionStart, now.selectionEnd], '全部選んだまま戻した').toEqual([1, 1]);
    // ⚠ 「次の 1 打」を実際に当てる(位置の数字だけ見ても、実害は見えない)
    now.setRangeText('X', now.selectionStart ?? 0, now.selectionEnd ?? 0, 'end');
    expect(now.value, '次の 1 打で打ちかけの字が消えた').toBe('いXう');
  });

  /**
   * 🔴 **別の面の欄を掴まない**(レビュー A-4。変異 M11 が生き延びた)。
   *
   * ⚠ 欄の名前(`data-pkc-field="cell-input"`)は**面ごとに変わらない**ので、
   *   ここのスコープを 1 文字緩めると「**別のノートの升へ打ちかけの字が移る**」
   *   という、いちばん静かなデータの取り違えになる。
   * ⚠ 直す前は主張(docstring)だけで、守る検査が 1 件も無かった。
   */
  it('🔴 別の面で開いている欄は、掴まないし開き直さない', () => {
    const a = document.createElement('div');
    const b = host([
      [2, 0, '1'],
      [2, 1, '2'],
    ]);
    // ⚠ 面 A は同じ形の升を持つが、欄は開いていない
    for (const [line, col, raw] of [
      [2, 0, '1'],
      [2, 1, '2'],
    ] as [number, number, string][]) {
      a.append(cell(line, col, raw));
    }
    document.body.append(a);
    typeInto(b, 1, 'りんご');

    expect(captureCellInput(a), '別の面の欄を掴んだ').toBeNull();
    // ⚠ 空振り防止 ── その欄は確かに開いている(面 B から見れば掴める)
    const keep = captureCellInput(b);
    expect(keep, '前提が崩れた(欄が開いていない)').not.toBeNull();

    reopenCellInput(a, keep!);
    expect(a.querySelector('[data-pkc-field="cell-input"]'), '別の面へ開き直した').toBeNull();
  });
});

/**
 * 🔴 **`Tab` / `Enter` で隣の升へ移る**(#750 I1。user 裁定 2026-09-06)。
 *
 * ⚠ ここが見るのは**隣の選び方**である ── 打った字が本当に本文へ入るかは
 *   実ブラウザの smoke(`md-table-cell.smoke.spec.ts`)が見る。
 * 🔑 **行番号と列番号の計算で出さない**のが肝:押せない升(区切りの行 / 原文に
 *   その升が無い行)には印が焼かれないので、計算で出すと**押しても何も起きない升**
 *   へ移る(#750 I4 がまさにその形)。だから**印の在る升だけ**から選ぶ。
 */
describe('隣の升へ移る(#750 I1)', () => {
  /** 表 1 つぶんの塊。⚠ `neighborCell` は `.pkc-md-block` の中だけを見る。 */
  function block(cells: readonly [number, number, string][]): HTMLElement {
    const b = document.createElement('div');
    b.className = 'pkc-md-block';
    for (const [line, col, raw] of cells) {
      const td = cell(line, col, raw);
      td.addEventListener('click', () => {
        const input = document.createElement('input');
        input.setAttribute('data-pkc-field', 'cell-input');
        input.value = td.getAttribute('data-pkc-cell-raw') ?? '';
        td.replaceChildren(input);
      });
      b.append(td);
    }
    return b;
  }

  const at = (b: HTMLElement, nth: number): HTMLElement =>
    [...b.querySelectorAll<HTMLElement>('[data-pkc-action="edit-cell"]')][nth]!;

  beforeEach(() => {
    document.body.innerHTML = '';
    requestCellMove(null);
  });

  it('🔴 右は次の升、左は前の升(行の端では次 / 前の行へ回る)', () => {
    const b = block([
      [2, 0, 'a'],
      [2, 1, 'b'],
      [3, 0, 'c'],
      [3, 1, 'd'],
    ]);
    document.body.append(b);
    expect(neighborCell(at(b, 0), 'right'), '右へ行けていない').toEqual({ line: '2', col: '1' });
    // 🔑 行の端 ── 次の行の左端へ回る(表計算と同じ。回らないと右端で手が止まる)
    expect(neighborCell(at(b, 1), 'right'), '行の端で次の行へ回っていない').toEqual({
      line: '3',
      col: '0',
    });
    expect(neighborCell(at(b, 2), 'left'), '左へ戻れていない').toEqual({ line: '2', col: '1' });
    // ⚠ **行き先が無ければ null**(呼び側はそのとき閉じる ── 動かない欄を残さない)
    expect(neighborCell(at(b, 3), 'right'), '最後の升から先へ行けてしまう').toBeNull();
    expect(neighborCell(at(b, 0), 'left'), '最初の升から前へ行けてしまう').toBeNull();
  });

  it('🔴 下は「同じ列の、いちばん近い下の升」(並び順の次ではない)', () => {
    const b = block([
      [2, 0, 'a'],
      [2, 1, 'b'],
      [3, 0, 'c'],
      [3, 1, 'd'],
      [4, 0, 'e'],
    ]);
    document.body.append(b);
    expect(neighborCell(at(b, 1), 'down'), '同じ列の下へ行けていない').toEqual({
      line: '3',
      col: '1',
    });
    // ⚠ 対照群 ── 並び順の次は `[3,0]` なので、そちらを返していたらこの検査は落ちる
    expect(neighborCell(at(b, 1), 'right'), '前提が崩れている').toEqual({ line: '3', col: '0' });
    expect(neighborCell(at(b, 3), 'down'), 'その列の下は無いのに動いた').toBeNull();
  });

  it('🔴 押せない升は飛ばす(印の在る升だけから選ぶ)', () => {
    /**
     * ⚠ 3 列目は**原文にその升が無い**行(`| 1 |` とだけ書いた形)なので、
     *   描き手は印を焼かない(#750 I4)。⚠ 番号で計算すると、ここへ移って
     *   **押しても何も起きない**升に欄が開かないまま止まる。
     */
    const b = block([
      [2, 0, 'a'],
      [2, 2, 'c'],
    ]);
    const dead = document.createElement('td');
    dead.setAttribute('data-pkc-cell-line', '2');
    dead.setAttribute('data-pkc-cell-col', '1');
    b.insertBefore(dead, b.children[1]!);
    document.body.append(b);
    expect(neighborCell(at(b, 0), 'right'), '押せない升へ移った').toEqual({ line: '2', col: '2' });
  });

  it('🔴 別の表へは飛び移らない(塊の中だけ)', () => {
    const one = block([[2, 0, 'a']]);
    const two = block([[9, 0, 'z']]);
    document.body.append(one, two);
    expect(neighborCell(at(one, 0), 'right'), '別の表の升へ飛び移った').toBeNull();
  });

  it('🔴 予約は 1 回だけ有効(読んだら消える)', () => {
    /**
     * ⚠ 残すと、**無関係な描き直し**で押していない升が突然開く ──
     *   `detail.ts` は描き直しのたびに読むので、消さないと毎回開くことになる。
     */
    requestCellMove({ line: '3', col: '1' });
    expect(takeCellMove(), '預けた行き先が返ってこない').toEqual({ line: '3', col: '1' });
    expect(takeCellMove(), '読んだのに残っている(次の描き直しで升が開く)').toBeNull();
  });

  it('🔴 予約した升を開ける ── 無ければ開かないと言う', () => {
    const b = block([
      [2, 0, 'a'],
      [2, 1, 'b'],
    ]);
    document.body.append(b);
    expect(openCellAt(b, { line: '2', col: '1' }), '予約した升を開けていない').toBe(true);
    expect(
      b.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]')?.value,
      '開いた欄が別の升のもの',
    ).toBe('b');
    document.body.innerHTML = '';
    const gone = block([[2, 0, 'a']]);
    document.body.append(gone);
    expect(openCellAt(gone, { line: '9', col: '9' }), '無い升を開けたと言った').toBe(false);
  });
});
