/**
 * 🔴 **本文の素の電話番号を押せる字にするか**(#278 段②)。
 *
 * ⚠ **既定は切** ── 入れると、いま読めている数字が**押せる字**になる
 *   (本文の見え方が変わる。user 指示 2026-08-28「変更はユーザーに委ねて欲しい」)。
 * ⚠ 字は「何が起きるか」で書く ── 「tel: リンクにする」は内部の言葉である
 *   (CLAUDE.md「画面で何が起きるかの言葉で書く」)。
 *
 * 🔴 **この説明だけ 2 行まで許す**(#1038 段 J の着地前、全量の unit が捕まえた)。
 * ⚠ 1 行に縮めた 1 稿目は「日付は変わらない」「切なら 1 文字も変わらない」を落とした ──
 *   どちらも #278 段②で「いちばん誤解されるのはここ」として**先に言う**と決めた文である
 *   (`tests/adapter/settings-phone-links.test.ts`)。設計 doc §9 C18 の「その 1 件だけ
 *   2 行を許す」を当て、`tests/adapter/settings-notes.test.ts` の既知の一覧で固定する。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { PhoneLinksStore } from '../phone-links';
import { buildCheckboxRow, syncCheckbox } from './checkbox';
import type { SettingsSection } from './section';

export function createPhoneLinksSection(
  region: HTMLElement,
  store: PhoneLinksStore,
): SettingsSection {
  return {
    id: 'phone-links',
    group: 'edit',
    build(): Node[] {
      const row = buildCheckboxRow({
        term: '本文の電話番号',
        action: 'set-phone-links',
        field: 'phone-links',
        label: ' 本文に書いた電話番号を押せるようにする',
        title:
          '日付や章番号は変わりません(0 か + で始まる 10〜11 桁だけを見ています)。' +
          '電話をかけられるかは端末しだいです(パソコンでは何も起きないことがあります)。',
        notes: [
          '本文の 090-1234-5678 のような番号を、押すと電話をかけられる字にします。日付(2026-09-09)は変わらず、オフのままなら本文の見え方は 1 文字も変わりません。',
        ],
      });
      return [row.dt, row.dd];
    },
    sync(): void {
      syncCheckbox(region, 'phone-links', () => store.enabled());
    },
  };
}
