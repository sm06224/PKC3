/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリ自身の確認ダイアログ**(#299。user 裁定 2026-08-21)。
 *
 * 🔑 **この file が在ること自体が、差し替えの取り分である。**
 *   `window.confirm` は happy-dom に**無い**ので、いままで確認の枝は
 *   **unit から 1 度も実行されていなかった**(CLAUDE.md §2)。
 *   `<dialog>` は happy-dom にも在る(`showModal` / `close(値)` / `returnValue` を
 *   実測で確認)ので、ここから**本物と同じ経路**を叩ける。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  alertInApp,
  confirmInApp,
  DIALOG_REGION,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';

const q = <T extends HTMLElement>(sel: string): T =>
  document.querySelector<T>(sel) as T;
const dialog = (): HTMLDialogElement => q<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const okBtn = (): HTMLButtonElement => q<HTMLButtonElement>('[data-pkc-field="dialog-ok"]');
const cancelBtn = (): HTMLButtonElement => q<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]');
const bodyText = (): string => q('[data-pkc-field="dialog-body"]').textContent ?? '';
/**
 * ⚠ **並んだ 1 枚が出るのはマイクロタスク 1 つ後**(器は「空いていれば同期、
 *   重なったときだけ並ばせる」形)。⚠ `setTimeout` で待たない ── 待ち時間で
 *   ごまかすと、本当に出ていないときも通る。
 */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('アプリ自身の確認ダイアログ(#299)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    host = document.createElement('div');
    document.body.append(host);
  });

  it('🔴 開くと本文が出て、実際に modal として開いている', async () => {
    const p = confirmInApp(host, '3 件を削除しますか?');
    expect(dialog().open, 'ダイアログが開いていない').toBe(true);
    expect(bodyText()).toBe('3 件を削除しますか?');
    cancelBtn().click();
    await p;
  });

  it('🔴 受ければ ok、取り消せば cancel', async () => {
    const yes = confirmInApp(host, 'A');
    okBtn().click();
    expect(await yes).toBe('ok');

    const no = confirmInApp(host, 'B');
    cancelBtn().click();
    expect(await no).toBe('cancel');
  });

  /**
   * 🔴 **`Escape` は「やめる」と同じ**。⚠ `Escape` で閉じると `returnValue` は
   *   **空**になるので、そこを見落とすと「押していないのに ok」になる
   *   ── いちばん危ない取り違えなので名指しで pin する。
   */
  it('🔴 Escape(値なしで閉じる)は取り消し扱い', async () => {
    const p = confirmInApp(host, 'C');
    dialog().close(); // 値を渡さない = Escape と同じ
    expect(await p).toBe('cancel');
  });

  /** ⚠ 知らせるだけの形は**ボタンが 1 つ** ── 取り消す先が無いのに出さない。 */
  it('知らせるだけの形は、取り消しのボタンを出さない', async () => {
    const p = alertInApp(host, '掃除しました');
    expect(cancelBtn().hidden, '取り消しのボタンが出ている').toBe(true);
    expect(okBtn().textContent).toBe('閉じる');
    okBtn().click();
    expect(await p).toBe('ok');
  });

  /**
   * ⚠ **前回の答えを持ち越さない。**
   *
   * 🔴 1 稿目は答えを `dialog.returnValue` に持たせていた ── 仕様では
   *   `close()` しても**残る**ので、開き直して `Escape` すると
   *   **押していない `ok`** が返る。⚠ ところが **happy-dom は素の `close()` で
   *   空に戻す**(実測)ので、**この test は当時も緑だった**
   *   (変異試験で「持ち越す」変異が生き延びて気づいた)。
   * 🔑 いまは答えを**1 回の呼び出しに閉じた局所変数**で持つので、持ち越しは
   *   **構造として起こりえない** ── この test は「壊れないこと」の見張りである。
   */
  it('🔴 前回 ok で閉じた後、開き直して Escape すると取り消しになる', async () => {
    const first = confirmInApp(host, 'D');
    okBtn().click();
    expect(await first).toBe('ok');

    const second = confirmInApp(host, 'E');
    dialog().close();
    expect(await second, '前回の ok を持ち越している').toBe('cancel');
  });

  /** ⚠ 器は**使い回す**(開くたびに作り直さない)。 */
  it('2 回開いても器は 1 つ', async () => {
    const a = confirmInApp(host, 'F');
    cancelBtn().click();
    await a;
    const b = confirmInApp(host, 'G');
    cancelBtn().click();
    await b;
    expect(document.querySelectorAll(`[data-pkc-region="${DIALOG_REGION}"]`).length).toBe(1);
  });

  /**
   * 🔴 **重なったら順番に出す。捨てない**(#299 段⑤。着地前レビュー R7)。
   *
   * ⚠ 段① は「2 枚目は待たずに `cancel` を返す」形だった ── 重ねて片方が
   *   永久に待つのを避けるためだが、**代わりに「頼んだ操作が黙って消える」**を作った:
   *   添付の整理は走査(worker で数秒)のあとに確認を出すので、その間にノートを
   *   削除すると **整理の確認が即 `cancel` になり、帯にも画面にも 1 行も出ない**。
   * 🔑 native の `confirm` は直列だった。置き換えるならそこも真似る。
   */
  it('🔴 重なった確認は捨てずに、順番に出す', async () => {
    const first = confirmInApp(host, 'H');
    const second = confirmInApp(host, 'I');
    // ⚠ 1 枚目が出ている間に 2 枚目が本文を書き換えていない
    expect(bodyText(), '1 枚目の本文が上書きされた').toBe('H');
    cancelBtn().click();
    expect(await first).toBe('cancel');
    await tick();
    // 🔑 **2 枚目はここで初めて出る**(捨てられていない)
    expect(dialog().open, '2 枚目が出ていない(捨てられた)').toBe(true);
    expect(bodyText()).toBe('I');
    okBtn().click();
    expect(await second, '2 枚目の答えが返らない').toBe('ok');
  });

  /**
   * 🔴 **知らせるものは絶対に捨てない。**
   * ⚠ ここは `confirmInApp` とは**別の関数**なので、上の test は 1 度も通らない
   *   (CLAUDE.md §7「同じ判定が複数の場所にある」)── 段① は alert 側の
   *   取りこぼしを 1 件も見ていなかった。実害は**断りの理由が丸ごと消える**こと
   *   (「他のタブで編集中です(整理は行っていません)」はこれでしか届かない)。
   */
  it('🔴 確認が開いている間に来た「お知らせ」も、順番に出る', async () => {
    const asking = confirmInApp(host, 'P');
    const telling = alertInApp(host, '他のタブで編集中です(整理は行っていません)');
    expect(bodyText(), '確認の本文がお知らせに書き換えられた').toBe('P');
    cancelBtn().click();
    expect(await asking).toBe('cancel');
    await tick();
    expect(dialog().open, 'お知らせが出ていない(捨てられた)').toBe(true);
    expect(bodyText()).toContain('整理は行っていません');
    expect(cancelBtn().hidden, '知らせるだけなのに「やめる」が出ている').toBe(true);
    okBtn().click();
    await telling;
  });

  /**
   * 🔴 **待っている間に面ごと組み直されても、鍵を殺さない**(着地前レビュー R8)。
   *
   * ⚠ 焦点の戻しは**要素の同一性**で書いてあるので、掴んだ節点が消えると誰も戻さない。
   *   面の側の持ち越しも働かない ── `filer.ts` は「組み直す**直前**に焦点が面の中に
   *   あったか」で判定するが、そのとき焦点は**ダイアログに在る**。
   * ⚠ native の `confirm` はレンダラごと止めるので、この窓は無かった。
   */
  it('🔴 開いている間に行が作り直されたら、焦点は**その面**へ返す', async () => {
    const region = document.createElement('section');
    region.setAttribute('data-pkc-region', 'filer-table');
    const table = document.createElement('table');
    table.tabIndex = 0; // filer.ts:411 と同じ(面の中で焦点を受けられる唯一の節点)
    const row = document.createElement('tr');
    row.tabIndex = -1;
    table.append(row);
    region.append(table);
    host.append(region);
    row.focus();
    expect(document.activeElement, '前提が崩れている').toBe(row);

    const p = confirmInApp(host, 'Q');
    // 待っている間に面ごと組み直される(掴んだ行は消える)
    table.textContent = '';
    okBtn().click();
    expect(await p).toBe('ok');
    expect(document.activeElement, '焦点が面の外へ落ちた(鍵が全部死ぬ)').toBe(table);
  });

  /** 危険色は**受けボタンだけ**に付く(地には付けない)。 */
  it('危険な操作では受けボタンに印が付き、既定では付かない', async () => {
    const danger = confirmInApp(host, 'J', { danger: true, okLabel: '削除' });
    expect(okBtn().hasAttribute('data-pkc-danger')).toBe(true);
    expect(okBtn().textContent).toBe('削除');
    cancelBtn().click();
    await danger;

    const plain = confirmInApp(host, 'K');
    expect(okBtn().hasAttribute('data-pkc-danger'), '危険色が持ち越された').toBe(false);
    cancelBtn().click();
    await plain;
  });

  /**
   * 🔴 **借りた焦点を返す**(2026-08-21、段② で実際に踏んだ)。
   *
   * ⚠ `showModal()` は焦点をダイアログへ移す。native の `confirm` は閉じたときに
   *   勝手に戻すが、`<dialog>` は**戻さない** ── 実害は「押した後に鍵が死ぬ」形で
   *   出た(ファイラは組み直す直前に「表の中に焦点があったか」を見て戻すので、
   *   焦点がダイアログに居ると `null` と判定され、削除後に `body` へ落ちる)。
   */
  it('🔴 閉じたら、開く前に焦点があった所へ返す', async () => {
    const before = document.createElement('button');
    host.append(before);
    before.focus();
    expect(document.activeElement, '前提が崩れている').toBe(before);

    const p = confirmInApp(host, 'M');
    expect(document.activeElement, 'ダイアログへ焦点が移っていない').toBe(cancelBtn());
    cancelBtn().click();
    await p;
    expect(document.activeElement, '焦点が返ってきていない(押した後に鍵が死ぬ)').toBe(before);
  });

  /** ⚠ 開く前の要素が**消えていたら**、焦点を当てにいかない(例外にしない)。 */
  it('開く前の要素が消えていたら、焦点を戻さない', async () => {
    const gone = document.createElement('button');
    host.append(gone);
    gone.focus();
    const p = confirmInApp(host, 'N');
    gone.remove();
    expect(() => okBtn().click()).not.toThrow();
    expect(await p).toBe('ok');
  });

  /**
   * 🔑 **取り消しが左、受けるのが右**(macOS / GNOME の並び)。
   *   マニュアル §4「確認の画面」が**位置はいつも同じ**と約束しているので、
   *   並びは**字面ではなく実際の DOM の順**で pin する。
   * ⚠ どちらも `type="button"` ── `<form method="dialog">` にすると
   *   **Enter で先頭のボタンが暗黙に押される**ので、削除が Enter 1 つで通る。
   */
  it('🔴 ボタンの並びは 取り消し → 受ける で、どちらも type="button"', async () => {
    const p = confirmInApp(host, 'O', { danger: true, okLabel: '削除する' });
    const row = q('[data-pkc-region="dialog-buttons"]');
    expect([...row.children].map((el) => el.getAttribute('data-pkc-field'))).toEqual([
      'dialog-cancel',
      'dialog-ok',
    ]);
    expect([cancelBtn().type, okBtn().type], 'Enter で暗黙に押される形になっている').toEqual([
      'button',
      'button',
    ]);
    cancelBtn().click();
    await p;
  });

  /** 🔑 焦点は**取り消す側** ── 戻しにくい操作で Enter が事故にならない。 */
  it('🔴 開いた直後の焦点は取り消す側', async () => {
    const p = confirmInApp(host, 'L', { danger: true });
    expect(document.activeElement, '焦点が受ける側に在る(Enter で通ってしまう)').toBe(
      cancelBtn(),
    );
    cancelBtn().click();
    await p;
  });
});
