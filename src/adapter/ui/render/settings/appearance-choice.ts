/**
 * 「アクセントの色」「字体」(#1982 段 4)。⚠ flag ではない(正規設定)── この端末の見た目の好み。
 */
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_FONT, FONTS } from '@features/appearance-choice';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentAccent, currentFont } from '../appearance-choice';
import { markDefault } from './default-mark';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createAccentSection(region: HTMLElement): SettingsSection {
  return {
    id: 'accent',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = 'アクセントの色';
      const dd = document.createElement('dd');
      dd.append(
        buildChoiceRow({
          field: 'accent-select',
          ariaLabel: 'アクセントの色',
          action: 'set-accent',
          dataAttr: 'data-pkc-accent-value',
          choices: markDefault(ACCENTS, DEFAULT_ACCENT),
          currentId: '',
        }),
      );
      dd.append(buildSettingsNote('主のボタンとフォーカスの色を、配色とは別に選べます。この端末で覚えます。'));
      return [dt, dd];
    },
    sync(): void {
      syncChoiceRow(region, 'accent-select', 'data-pkc-accent-value', currentAccent(document.documentElement));
    },
  };
}

export function createFontSection(region: HTMLElement): SettingsSection {
  return {
    id: 'font',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = '字体';
      const dd = document.createElement('dd');
      dd.append(
        buildChoiceRow({
          field: 'font-select',
          ariaLabel: '字体',
          action: 'set-font',
          dataAttr: 'data-pkc-font-value',
          choices: markDefault(FONTS, DEFAULT_FONT),
          currentId: '',
        }),
      );
      dd.append(
        buildSettingsNote('字体は同梱せず、この端末にあるものを使います(無ければ標準)。'),
      );
      return [dt, dd];
    },
    sync(): void {
      syncChoiceRow(region, 'font-select', 'data-pkc-font-value', currentFont(document.documentElement));
    },
  };
}
