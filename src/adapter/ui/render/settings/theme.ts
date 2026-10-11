/**
 * 配色(「表示」の h4)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { readThemeChoice, THEME_AUTO, THEME_AUTO_LABEL, THEMES } from '../theme';
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
      select.title = '「OS に合わせる」を選ぶと、OS の明るい・暗いの切り替えに付いていきます。選んだ配色はこの端末で覚えます。';
      const auto = document.createElement('option');
      auto.value = THEME_AUTO;
      auto.textContent = THEME_AUTO_LABEL;
      select.append(auto);
      for (const t of THEMES) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        select.append(opt);
      }
      dd.append(select);
      dd.append(buildSettingsNote('選ぶと、この端末で覚えます(「OS に合わせる」は、OS が暗い・明るいに切り替わると付いてきます)。'));
      return [dt, dd];
    },
    /** ⚠ 画面の値を**いまの配色に合わせる**(合わせないと画面が嘘をつく)。 */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>('[data-pkc-field="theme-select"]');
      // 🔑 見せるのは「選び方」(保存)── 属性は「OS に合わせる」だと実際の配色になる
      const cur = readThemeChoice();
      if (select && select.value !== cur) select.value = cur;
    },
  };
}
