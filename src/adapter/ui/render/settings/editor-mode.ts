/**
 * ✏️ **編集の仕方**(#104 第 2 弾。user 裁定 2026-08-08「既定でONかつ
 * 設定で2ペイン編集はできるようにする」)。
 * ⚠ **flag ではない**(正規設定)── flag `editor.live` はここへ昇格して退役した。
 * ⚠ **2026-09-21(#1017 段③-1)に「表示」から h4「編集」へ移した** ──
 *   書き方の作法であって、見た目の好みではない。
 *
 * 🔴 **選択肢は 2 つだが、プルダウンのまま残す**(#1038 段J-2、§9 の覆る条件)。
 *   ⚠ 一度ボタンの列にして実測(`TAB_SWEEP` 全幅 + スマホ幅 360 / 390px)した
 *   ところ、**スマホ幅の 390px と 360px の両方で 2 行に折れた**(選択肢の字が
 *   長い ──「1 画面で編集(ライブ)」「2 ペイン(原文とプレビュー)」。`TAB_SWEEP`
 *   側は 11 幅とも 1 行のまま)。doc §9「切替ボタンの列にして…行が 2 段以上に
 *   折れる → その項目だけプルダウンへ戻す」のとおり、プルダウンへ戻した
 *   (本文のタグの見せ方と同じ扱い)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { EDITOR_MODES } from '@features/editor-mode';
import type { EditorModeStore } from '../editor-mode';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createEditorModeSection(
  region: HTMLElement,
  store: EditorModeStore,
): SettingsSection {
  return {
    id: 'editor-mode',
    group: 'edit',
    build(): Node[] {
      const et = document.createElement('dt');
      et.textContent = '編集の仕方';
      const ed = document.createElement('dd');
      const eselect = document.createElement('select');
      eselect.setAttribute('data-pkc-action', 'set-editor-mode');
      eselect.setAttribute('data-pkc-field', 'editor-mode-select');
      eselect.setAttribute('aria-label', '編集の仕方');
      // ⚠ **いつ効くか**を書く ── 書かないと「押したのに変わらない」に見える
      eselect.title =
        '既定は「1 画面で編集(ライブ)」で、押した行だけがマークダウンの元の文になり、' +
        'その場で書き換えられます。2 ペインは左に原文、右にプレビューが並びます。';
      for (const c of EDITOR_MODES) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        eselect.append(opt);
      }
      ed.append(eselect);
      ed.append(buildSettingsNote('本文の書き方を選びます(次に編集を開いたときから効きます)。'));
      return [et, ed];
    },
    /**
     * ⚠ 画面の値を**いまの編集の仕方に合わせる**(器は 1 度しか組まない ──
     * 映さないと古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。
     */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>(
        '[data-pkc-field="editor-mode-select"]',
      );
      const cur = store.getMode();
      if (select && select.value !== cur) select.value = cur;
    },
  };
}
