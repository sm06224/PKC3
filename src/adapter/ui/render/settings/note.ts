/**
 * 🔴 **説明は 1 行 + 詳しくは hover / マニュアルへ**(#1017 §6.1 規則 3、
 * #1038 段J で全 24 項目に適用)。⚠ **不可逆・データが消える警告はここへ流さない**
 * ── そのまま可視の 1 行に残す(`persist-state` / 「ノートを渡して開くことを
 * 許したアプリ」の note がその実例。`tests/adapter/settings-notes.test.ts` の
 * `KNOWN_MULTILINE` が例外を等値 pin する)。
 *
 * (#1382 で `settings.ts` から移した。節のファイルが共有できるよう export にしただけで、
 * 中身は変えていない。)
 */
export function buildSettingsNote(text: string): HTMLParagraphElement {
  const note = document.createElement('p');
  note.setAttribute('data-pkc-field', 'settings-note');
  note.textContent = text;
  return note;
}
