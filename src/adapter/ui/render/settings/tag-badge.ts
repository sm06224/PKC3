/**
 * 🔴 **本文の中のタグの見せ方**(#550 段③。user 要望「タグはバッジ化して表示が必要」)。
 *
 * ⚠ 既定は**札**(頼まれたことをやる)。ただし**その場で「文字のまま」へ戻せる**
 *   ── user 指示 2026-08-28「正直変更はユーザーに委ねて欲しい」/
 *   「**user が選べる形にできるなら、そちらを先に出す**」(#504 と同じ作法)。
 * ⚠ タグごとに**色**を振る案は出していない ── user 指示 2026-08-03
 *   「地は無彩色、色は情報にだけ使う」を覆す提案になるため。
 *
 * 🔴 **選択肢は 3 つだが、プルダウンのまま残す**(#1038 段J、§9 の覆る条件)。
 *   ⚠ ボタンの列にして実測(`TAB_SWEEP` 全幅)したところ、**720 / 860 / 901 /
 *   950 / 1101px で 2 行に折れた**(選択肢の字が長い ── 「枠だけのバッジ
 *   (下地なし・細い枠)」等)。doc §9「切替ボタンの列にして 8 幅のどこかで
 *   行が 2 段以上に折れる → その項目だけプルダウンへ戻す」のとおり、ここだけ
 *   プルダウンへ戻した(他の 9 項目は全幅で 1 行に収まる)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { TAG_BADGES } from '@features/tag-badge';
import { currentTagBadge } from '../tag-badge';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createTagBadgeSection(region: HTMLElement): SettingsSection {
  return {
    id: 'tag-badge',
    group: 'display',
    build(): Node[] {
      const gt = document.createElement('dt');
      gt.textContent = '本文のタグの見せ方';
      const gd = document.createElement('dd');
      const gselect = document.createElement('select');
      gselect.setAttribute('data-pkc-action', 'set-tag-badge');
      gselect.setAttribute('data-pkc-field', 'tag-badge-select');
      gselect.setAttribute('aria-label', '本文のタグの見せ方');
      gselect.title = '本文に「#買い物 #家事」と書いた行の見え方です。押すとその場で効きます。';
      for (const c of TAG_BADGES) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        gselect.append(opt);
      }
      gd.append(gselect);
      gd.append(
        buildSettingsNote('本文に書いたタグ(#買い物 など)の見え方です(本文の字は変わりません)。'),
      );
      return [gt, gd];
    },
    /** ⚠ タグの見せ方も映す(理由は他の選択欄と同じ。⚠ ここはプルダウンのまま)。 */
    sync(): void {
      const badge = region.querySelector<HTMLSelectElement>('[data-pkc-field="tag-badge-select"]');
      const curBadge = currentTagBadge(document.documentElement);
      if (badge && badge.value !== curBadge) badge.value = curBadge;
    },
  };
}
