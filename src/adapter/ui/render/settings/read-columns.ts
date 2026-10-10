/**
 * 🔴 **本文の段組み**(#505 段①。user 指示 2026-08-28)。
 *
 * ⚠ ここ「表示」に置く ── 紙面・文字の大きさと同じ「見え方の好み」である。
 * ⚠ **既定は 1 段 = 現行そのまま** ── 選ばなければ見え方は変わらない。
 * (#1382 で `settings.ts` から移した。中身は変えていない。段の線・タグの見せ方は
 * `column-rule.ts` / `tag-badge.ts` に分けた。)
 */
import {
  effectiveColumns,
  minWidthForColumns,
  READ_COLUMN_CHOICES,
  readColumnsSpec,
  type ReadColumns,
} from '@features/read-columns';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentReadColumns, lastReadPaneMetrics } from '../read-columns';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

/**
 * 🔴 **「いま何段か」を画面の字にする**(#526)。
 *
 * ⚠ **器を実測して決める** ── 選んだ数ではなく、**CSS が実際に作る数**である。
 *   採寸できない環境(happy-dom / 面が畳まれている)では**何も言わない**
 *   ── 嘘を書くより黙るほうがよい。
 */
function syncColumnsEffective(region: ParentNode, chosen: ReadColumns): void {
  const el = region.querySelector<HTMLElement>('[data-pkc-field="read-columns-effective"]');
  if (!el) return;
  /**
   * 🔴 **自分で採寸しない**(#551、2026-08-29 に判明)。
   *
   * ⚠ 1 稿目はここで `detail-body` を `getBoundingClientRect()` していたが、
   *   **設定画面が出ている間、読む面は `hidden` = 幅 0** である
   *   (面は排他 + `[hidden] { display: none !important }`)── つまり
   *   **必ず下の早期 return に落ち、この注記は配った日から 1 度も出ていなかった**。
   *   ⚠ test も 0 件だったので、誰も鳴らなかった(#526 で足した機能が丸ごと死んでいた)。
   * 🔑 段組の機構が**既に採っている**値を読む(`lastReadPaneMetrics`)──
   *   測る場所を 2 か所に作らない(CLAUDE.md §7)。
   * ⚠ **生きた採寸を優先する** ── 読む面が見えている場面(将来この注記を
   *   別の面へ出すとき)では、憶えた値より今の値のほうが正しい。
   */
  const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]');
  const live = host?.getBoundingClientRect().width ?? 0;
  const liveFont = host === null ? 0 : Number.parseFloat(getComputedStyle(host).fontSize);
  const remembered = lastReadPaneMetrics();
  const width = live > 0 ? live : (remembered?.width ?? 0);
  const fontPx =
    live > 0 && Number.isFinite(liveFont) && liveFont > 0
      ? liveFont
      : (remembered?.fontPx ?? 0);
  const count = readColumnsSpec(chosen).count;
  if (width <= 0 || !Number.isFinite(fontPx) || fontPx <= 0) {
    el.textContent = '';
    return;
  }
  const eff = effectiveColumns(width, count, fontPx);
  if (count <= 1) {
    el.textContent = '';
    return;
  }
  if (eff === count) {
    el.textContent = `いまの画面では ${eff} 段で出ています。`;
    return;
  }
  if (eff <= 1) {
    el.textContent =
      `いまの画面は段組みには狭いので、ふつうの 1 段で表示しています` +
      `(${count} 段には ${Math.ceil(minWidthForColumns(2, fontPx))}px 以上の幅が要ります)。`;
    return;
  }
  el.textContent =
    `いまの画面では ${eff} 段で出ています` +
    `(${count} 段には ${Math.ceil(minWidthForColumns(count, fontPx))}px 以上の幅が要ります)。`;
}

export function createReadColumnsSection(region: HTMLElement): SettingsSection {
  return {
    id: 'read-columns',
    group: 'display',
    build(): Node[] {
      const ct = document.createElement('dt');
      ct.textContent = '本文の段組み';
      const cd = document.createElement('dd');
      // 🔴 選択肢 4 つ ── プルダウンをボタンの列にする(#1038 段J)
      const cRow = buildChoiceRow({
        field: 'read-columns-select',
        ariaLabel: '本文の段組み',
        action: 'set-read-columns',
        dataAttr: 'data-pkc-read-columns-value',
        choices: READ_COLUMN_CHOICES,
        currentId: '', // render 末尾の sync が必ず映す
      });
      cRow.title =
        '読み進める向きが横になり、マウスのホイールでそのまま横へスクロールできます。' +
        '表と図は段の幅まで縮むので、広く見たいときは段を減らしてください。' +
        '2 ペインで編集している間は 1 段に戻ります(その場の編集では段のままです)。';
      cd.append(cRow);
      /**
       * 🔴 **いま実際に何段になっているかを出す**(#526。user 報告 2026-08-28
       * 「**2〜4 のどの数字を選んでもレンダリングは変わらなかった それはバグ?**」)。
       *
       * ⚠ 答えは「バグではない ── **器の幅で頭打ちになる**」で、**実装はそれを
       *   知っていた**(`columnsFit` の注記が「CSS が 2 段へ落とす」と書いている)。
       *   決まっていなかったのは **user に言うこと**だけだった。
       * 🔑 実測すると、器が **928〜1390px のあいだは 2/3/4 が全部 2 段**になる
       *   ── ごく普通の幅である。
       * ⚠ **選択肢は減らさない** ── いま狭くても、広い画面で開けば効く。
       */
      const ceff = document.createElement('p');
      ceff.setAttribute('data-pkc-field', 'read-columns-effective');
      ceff.setAttribute('data-pkc-note', 'effective');
      cd.append(ceff);
      // ⚠ **何が変わって、何に気をつけるか**を書く(押した後に探させない)。詳しくは hover とマニュアル。
      cd.append(
        buildSettingsNote('横に広い画面で、本文を段へ流します(狭いと自動で 1 段に戻ります)。'),
      );
      return [ct, cd];
    },
    /**
     * ⚠ 画面の値を**いまの段数に合わせる**(#505)。器は 1 度しか組まないので、
     *   映さないと**別の面へ行って戻ると古い値が見える**(§7)。
     * ⚠ 正本は DOM(`applyReadColumns` が当てた属性)── 保存を読み直さない。
     */
    sync(): void {
      const cur = currentReadColumns(document.documentElement);
      syncChoiceRow(region, 'read-columns-select', 'data-pkc-read-columns-value', cur);
      syncColumnsEffective(region, cur);
    },
  };
}
