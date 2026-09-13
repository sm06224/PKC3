/** @vitest-environment happy-dom */
/**
 * 🔴 **目印の表は「共有の 1 本」**(#857 段② の裁定、2026-09-13)。
 *
 * > user 裁定:「**絵を並べた表にする**(タイルと同じ見た目 + いま付いている絵に枠)」
 *
 * ## なぜこの file が要るか
 *
 * ⚠ 表を出す所が **2 つ**ある:
 *
 * | 出る所 | 押すとどうなるか |
 * |---|---|
 * | 添付の設定(`detail.ts`) | `data-pkc-action="pick-app-icon"` を binder が受ける |
 * | グループの小窓(`app-dialog.ts`) | その場で閉じて、選んだ値が返る |
 *
 * 🔴 **片方だけで見ると、もう片方は渡し忘れても緑になる**
 *   (CLAUDE.md §7「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」)。
 *   だから**両方の呼び側から**見る。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TILE_ICON_CHOICES } from '../../src/features/icon/tile-icons';
import { ICON_NAME_ATTR, buildIconPalette } from '../../src/adapter/ui/render/icon-palette';
import { pickBodyIconInApp, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { answerDialog, openDialog } from './dialog-helper';

const palette = (current: string): HTMLElement =>
  buildIconPalette({ current, field: 'f', ariaLabel: 'a', each: () => {} });

describe('目印の表(#857 段②)', () => {
  it('🔴 タイルと同じ 49 種 +「なし」が、この順で並ぶ', () => {
    const box = palette('');
    const names = [...box.querySelectorAll('button')].map((b) => b.getAttribute(ICON_NAME_ATTR));
    // ⚠ 空振り防止 ── 正本の一覧が空なら、この検査は何も見ていない
    expect(TILE_ICON_CHOICES.length, '絵の正本が空(空振り)').toBeGreaterThanOrEqual(40);
    expect(names, '先頭が「なし」でない(外す口が先頭に無い)').toEqual([
      '',
      ...TILE_ICON_CHOICES.map((c) => c.name),
    ]);
  });

  it('🔴 いま付いている絵にだけ枠が付く', () => {
    const target = TILE_ICON_CHOICES[3]!.name;
    const box = palette(target);
    const on = [...box.querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '枠が 1 つに決まらない').toHaveLength(1);
    expect(on[0]?.getAttribute(ICON_NAME_ATTR), '別の絵に枠が付いている').toBe(target);
  });

  it('⚠ 何も付いていなければ「なし」に枠が付く', () => {
    const on = [...palette('').querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '枠が 1 つに決まらない').toHaveLength(1);
    expect(on[0]?.getAttribute(ICON_NAME_ATTR), '「なし」に枠が付いていない').toBe('');
  });

  /**
   * 🔴 **表に無い字(絵文字を直に貼った群)には、どこにも枠を付けない。**
   *
   * ⚠ 1 稿目は「**「なし」に落ちる**」と書いて落ちた ── 実装のほうが正しかった。
   * 🔑 その群には**目印が付いている**(🧮)ので、「なし」に枠を付けるのは**嘘**である。
   *   どこにも付かないのが「**この表の中には無い**」という正確な答えになる。
   * ⚠ 実際の経路では `appGroupIconName` が空を返すのでここへは来ないが、
   *   **来たときに嘘をつかない**ことを門にしておく。
   */
  it('🔴 表に無い字が来たら、どこにも枠を付けない(嘘の枠を作らない)', () => {
    const on = [...palette('🧮').querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '表に無い字なのに、どれかに枠が付いた(嘘の枠)').toHaveLength(0);
  });

  it('🔴 押す前に何か分かる道が在る(図案だけのボタンにしているため)', () => {
    const box = palette('');
    for (const b of box.querySelectorAll('button')) {
      expect(b.title, '日本語の呼び名が無い(押す前に何か分からない)').not.toBe('');
    }
  });

  /**
   * 🔴 **両方の呼び側が、この 1 本を通っていること**(§7)。
   * ⚠ どちらかが自前で表を組み直した日に**見た目が割れる**が、
   *   画面を見るまで誰も気づかない ── だから**原文で**見る。
   * ⚠ 弱い形だと自覚して使う(原文 pin)が、**2 本目を書いたら必ず落ちる**。
   */
  it('🔴 表を組む口は 1 つ ── 2 か所とも共有の 1 本を呼んでいる', () => {
    for (const f of [
      'src/adapter/ui/render/detail.ts',
      'src/adapter/ui/render/app-dialog.ts',
    ]) {
      const src = readFileSync(f, 'utf-8');
      expect(src, `${f} が共有の表を呼んでいない(2 本目を書いた)`).toContain('buildIconPalette(');
      expect(src, `${f} が絵の一覧を自前で読んでいる(表が 2 本になる)`).not.toContain(
        'TILE_ICON_CHOICES',
      );
    }
  });

  /**
   * 🔴 **見た目の印は 1 つ**(`data-pkc-palette`)── CSS はこれで当てる。
   * ⚠ `data-pkc-field` の名前で当てると、次に表を足した日に**付け忘れて崩れる**。
   */
  it('🔴 見た目の印が付いていて、CSS もそれで当てている', () => {
    expect(palette('').hasAttribute('data-pkc-palette'), '見た目の印が無い').toBe(true);
    const css = readFileSync('src/styles/app.css', 'utf-8');
    expect(css, 'CSS が印で当てていない').toContain('[data-pkc-palette] button[aria-pressed=');
    expect(css, 'CSS が面の名前で当てたまま(次に足すと崩れる)').not.toContain(
      "[data-pkc-field='app-icon-palette']",
    );
  });
});

/**
 * 🔴 **置き換えで落ちかけた性質**(#857 段②、2026-09-13)。
 *
 * ⚠ グループの小窓は「1 行選ぶ」の器(`pickRowInApp`)から**表へ置き換えた**。
 *   あちらは **`↑` `↓` で行を移れた**が、**その性質は仕様書のどこにも無かった**ので、
 *   表に替えたときに**黙って落ちていた**(CLAUDE.md §10)。
 * ⚠ 落ちると、鍵だけで使う人は **`Tab` を 49 回**押すことになる ── 画面は
 *   1 ドットも変わらないので、**誰も気づかない**。
 *
 * 🔴 **原文で見るのをやめた**(2026-09-13、#853 段①)。
 *
 * ⚠ 直す前は「`pickAppGroupIconInApp` の原文に `ArrowDown` の字が在るか」を見ていた。
 *   ところが #853 段① で**同じ小窓を本文へ入れる側でも使う**ことになり、矢印の処理を
 *   共有の 1 本(`pickIconFrom`)へ寄せた瞬間に**落ちた** ── 🔑 **製品は無傷で、
 *   壊れたのは検査の当て方**である(字の在処を見ていて、性質を見ていなかった)。
 * 🔑 いまは**押して確かめる** ── 小窓を開けて `ArrowDown` を撃ち、**焦点が隣へ移る**
 *   ことを見る。⚠ この形なら、寄せても分けても**性質が生きている限り緑**である。
 */
describe('置き換えで落とした性質を戻す(§10)', () => {
  afterEach(() => {
    resetAppDialogForTest();
    document.body.textContent = '';
  });

  /** 小窓を開いて、押し所と `<dialog>` を返す。 */
  async function openPalette(): Promise<{ dialog: HTMLDialogElement; picks: HTMLButtonElement[] }> {
    const host = document.createElement('div');
    document.body.append(host);
    void pickBodyIconInApp(host);
    // ⚠ 開くのは非同期(順番待ちの列を通る)── microtask を数周まわす
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const dialog = openDialog();
    expect(dialog, '小窓が開いていない(前提が崩れている)').not.toBeNull();
    const picks = [...dialog!.querySelectorAll<HTMLButtonElement>(`button[${ICON_NAME_ATTR}]`)];
    expect(picks.length, '絵の押し所が 1 つも無い(空振り)').toBeGreaterThan(10);
    return { dialog: dialog!, picks };
  }

  const arrow = (dialog: HTMLDialogElement, key: string): void => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  it('🔴 矢印で隣の絵へ移れる(器を替える前に在った性質)', async () => {
    const { dialog, picks } = await openPalette();
    picks[0]!.focus();
    expect(document.activeElement, '焦点を置けていない(前提が崩れている)').toBe(picks[0]);
    // 🔑 縦横どちらでも進む / 戻る ── 折り返しは幅で変わるので、鍵の意味にしない
    for (const [key, want] of [
      ['ArrowDown', 1],
      ['ArrowRight', 2],
      ['ArrowUp', 1],
      ['ArrowLeft', 0],
    ] as const) {
      arrow(dialog, key);
      expect(document.activeElement, `${key} で移れない(鍵だけの人が Tab を 49 回押す)`).toBe(
        picks[want],
      );
    }
    // ⚠ 対照群 ── 関係のない鍵では動かない(「何を押しても進む」ではない)
    arrow(dialog, 'a');
    expect(document.activeElement, '関係のない鍵でも動いている').toBe(picks[0]);
    await answerDialog('cancel');
  });

  /**
   * 🔴 **外(暗い地)を押したらやめる**(変異試験 M25 が教えた ── この動線を見る test が
   *   repo 全体に 1 本も無く、口を塞いでも誰も落ちなかった)。
   * ⚠ 選ぶだけの器なので、外を押したときに「何も選ばずに閉じる」以外の答えは無い。
   */
  it('🔴 外(暗い地)を押すとやめる', async () => {
    const { dialog, picks } = await openPalette();
    // 🔑 暗い地を押すと `target` は `<dialog>` 自身になる(中身を押せば中身が target)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(openDialog(), '外を押しても閉じていない').toBeNull();
    // ⚠ 対照群 ── **中身**を押したときは閉じ方が違う(選んだ値が返る道)。
    //    ここで「何を押しても閉じる」実装なら、上の assert は無条件に真になる。
    expect(picks[0]!.isConnected, '前提が崩れている(器ごと捨てられた)').toBe(true);
  });

  it('🔴 端では止まる(輪にしない ── 押し続けても迷子にならない)', async () => {
    const { dialog, picks } = await openPalette();
    picks[0]!.focus();
    arrow(dialog, 'ArrowUp');
    expect(document.activeElement, '先頭から上へ出た').toBe(picks[0]);
    await answerDialog('cancel');
  });

  /**
   * ⚠ **外し忘れない** ── 器は使い回すので、次の確認でも矢印が絵を探しにいく。
   * 🔑 ここは**閉じた後に撃つ**ことで見る(原文ではなく、振る舞いで)。
   */
  it('🔴 閉じた後は、矢印の聞き耳が外れている', async () => {
    const { dialog, picks } = await openPalette();
    picks[0]!.focus();
    await answerDialog('cancel');
    // ⚠ 閉じると**焦点は呼び出し元へ返る**(器の後始末)ので、撃つ前に置き直す
    //    ── 置き直さないと「焦点がどこにも無いから動かなかった」を合格と読む(空振り)
    picks[0]!.focus();
    expect(document.activeElement, '焦点を置き直せていない(空振り)').toBe(picks[0]);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    dialog.dispatchEvent(ev);
    expect(document.activeElement, '閉じたのに矢印がまだ効いている').toBe(picks[0]);
    expect(ev.defaultPrevented, '閉じたのに矢印を食べている').toBe(false);
  });
});
