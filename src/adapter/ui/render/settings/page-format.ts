/**
 * 📄 **紙面**(2026-08-08、user 裁定「読み幅は A4 と A3、フル HD と 4:3 の
 * 縦横を選べるようにし、デフォは A4 縦」)。
 *
 * ⚠ **flag ではない**(正規設定)── 恒久の user 設定で、畳む予定が無い。
 * ⚠ ここ「表示」に置く ── **見た目の好み**であって、外へ何が伝わるかの
 *   判断(外部の画像)とは別の節である。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { PAGE_FORMATS } from '@features/page-format';
import { currentPageFormat } from '../page-format';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createPageFormatSection(region: HTMLElement): SettingsSection {
  return {
    id: 'page-format',
    group: 'display',
    build(): Node[] {
      const pt = document.createElement('dt');
      pt.textContent = 'ページ設定';
      const pd = document.createElement('dd');
      const pselect = document.createElement('select');
      pselect.setAttribute('data-pkc-action', 'set-page-format');
      pselect.setAttribute('data-pkc-field', 'page-format-select');
      pselect.setAttribute('aria-label', 'ページ設定');
      // ⚠ **何が変わるのか**を書く ── 「紙面」だけでは、画面の話か紙の話か分からない
      pselect.title =
        'フル HD を選ぶと読み幅の上限が外れ、画面の幅いっぱいまで広がります。' +
        '表・図・コードには読み幅の上限が掛かりませんが、段落と同じ左端に揃います。' +
        '書き出した HTML は、書き出したときのページ設定のまま表示されます。';
      for (const f of PAGE_FORMATS) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.label;
        pselect.append(opt);
      }
      pd.append(pselect);
      pd.append(buildSettingsNote('本文の読み幅と印刷の紙の大きさが決まります(既定は A4 縦)。'));
      return [pt, pd];
    },
    /**
     * ⚠ 画面の値を**いまの紙面に合わせる**(2026-08-08)。
     * 🔴 **器は 1 度しか組まない**ので、映さないと**古い値が見える** ──
     * 起動時に保存から復元した値も、ここが呼ばれなければ選択欄は A4 縦のまま
     * (「設定したのに戻っている」と読まれる)。⚠ だから
     * 最初の組み立て直後と、組み済みの分岐の両方から呼ぶ(登録表を回す)。
     */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>(
        '[data-pkc-field="page-format-select"]',
      );
      // ⚠ 正本は DOM(`applyPageFormat` が当てた属性)── 保存を読み直さない
      const cur = currentPageFormat(document.documentElement);
      if (select && select.value !== cur) select.value = cur;
    },
  };
}
