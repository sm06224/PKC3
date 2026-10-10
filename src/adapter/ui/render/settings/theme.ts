/**
 * 配色(「表示」の h4)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { THEMES } from '../theme';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createThemeSection(region: HTMLElement): SettingsSection {
  return {
    id: 'theme',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = '配色';
      const dd = document.createElement('dd');
      const select = document.createElement('select');
      select.setAttribute('data-pkc-action', 'set-theme');
      select.setAttribute('data-pkc-field', 'theme-select');
      select.setAttribute('aria-label', '配色');
      // 🔑 説明は 1 行 + hover(#1017 §6.1 規則 3、#1038 段J)。詳しくはマニュアル。
      select.title = '最初は OS の設定に従い、選ぶとこの端末で覚えます。';
      for (const t of THEMES) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        select.append(opt);
      }
      dd.append(select);
      dd.append(buildSettingsNote('選ぶと、この端末で覚えます(最初は OS の設定に従います)。'));
      return [dt, dd];
    },
    /** ⚠ 画面の値を**いまの配色に合わせる**(合わせないと画面が嘘をつく)。 */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>('[data-pkc-field="theme-select"]');
      const cur = document.documentElement.getAttribute('data-pkc-theme');
      if (select && cur !== null && select.value !== cur) select.value = cur;
    },
  };
}
