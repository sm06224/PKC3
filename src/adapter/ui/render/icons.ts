/**
 * ボタンの図案(P8 段④)。
 *
 * > user 指示 2026-08-03「**アイコンや絵文字を使ってください**」
 * > 「**絵文字を使うとボタンの高さが合わないから、UI デザインとして
 * > ボタンサイズ揃えはしてください**」
 *
 * 🔴 **絵文字は文字送りも行送りも書体でばらつく**。素で `textContent` に混ぜると
 * ボタンごとに高さと幅が変わる ── だから:
 *  - 図案は**固定幅の枠**(`[data-pkc-icon]`)に入れる(CSS が `width` を決める)
 *  - 文字は**別の span**(`[data-pkc-field="label"]`)に入れる
 *  - 高さはボタン側で `--row-h` に固定する(中身で伸びない)
 *
 * ⚠ 図案だけのボタンを作らない ── 何のボタンか読めなくなる。図案は**添え物**で、
 * 意味は文字が持つ(`title` ではなく画面に出る文字が)。
 */

/** `data-pkc-action` → 図案。⚠ ここに無い action は図案なしで出る(壊れない)。 */
export const ACTION_ICONS: Readonly<Record<string, string>> = {
  'set-view:detail': '📄',
  'set-view:filer': '📁',
  'set-view:launcher': '🚀',
  'set-view:settings': '⚙',
  'import-file': '📥',
  'export-archive': '💾',
  'export-html': '🌐',
  'export-markdown': '📝',
  'purge-orphan-assets': '🧹',
  'create-entry': '＋',
  'attach-file': '📎',
  'start-edit': '✏',
  'append-section': '⤵',
  'commit-edit': '💾',
  'cancel-edit': '✕',
  'export-entry': '⬆',
  'show-history': '🕘',
  'delete-entry': '🗑',
  'show-trash': '🗑',
  'restore-trash': '↩',
  'purge-trash': '🧹',
  'filer-root': '🏠',
};

/** 種別 → 図案(一覧のチップ)。 */
export const ARCHETYPE_ICONS: Readonly<Record<string, string>> = {
  text: '📄',
  textlog: '📋',
  spreadsheet: '▦',
  folder: '📁',
  attachment: '📎',
  todo: '☑',
  form: '🗒',
};

/**
 * 図案つきボタンを作る。⚠ **中身の構造を 1 か所に固定する** ── ばらばらに組むと
 * 「このボタンだけ高さが違う」が生まれる(それが user 指摘の中身)。
 */
export function iconButton(action: string, label: string, iconKey = action): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', action);
  const icon = ACTION_ICONS[iconKey];
  if (icon !== undefined) {
    const span = document.createElement('span');
    span.setAttribute('data-pkc-icon', '');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = icon;
    btn.append(span);
  }
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'label');
  text.textContent = label;
  btn.append(text);
  return btn;
}
