/**
 * 🔴 **手が滑りやすい 2 つを切れるようにする**(#1087。決めたのは 2026-10-01、
 *   #1163 の約束事で Gemini の答え)。⚠ **既定は入のまま** ── 配ってあった動きを変えず、
 *   いやな人の逃げ道だけを足す。切っても他の見え方は変わらない。
 * ⚠ 説明は hover に置く(`missing-links` と同じ ── visible の note を足すと
 *   `settings-notes.test.ts` の段落数を動かす)。
 * ⚠ 字は「何が起きるか」で書く(「インラインコード」は内部の言葉 ── `ui-terms.ts` の BANNED_TERMS)。
 * (この節は「長いコードブロック」、次の `inline-code-copy` が「文中の短いコード」。)
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { CodeCollapseStore } from '../code-collapse';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createCodeCollapseSection(
  region: HTMLElement,
  store: CodeCollapseStore,
): SettingsSection {
  return {
    id: 'code-collapse',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '長いコードブロック',
        action: 'set-code-collapse',
        field: 'code-collapse',
        label: ' 長いコードブロックを最初から折りたたむ',
        title:
          '18 行以上のコードブロックを、最初は低く折りたたんで見せます(押すと全部見えます)。' +
          'オフにすると、最初から字が全部見えます(開閉のボタンも出ません)。',
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'code-collapse', () => store.enabled());
    },
  };
}
