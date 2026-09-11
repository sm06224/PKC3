/**
 * 🔴 **図案の正本**(#770 段①、2026-09-11)── PKC の図案名 → **Material Symbols** の
 * 絵と符号位置。
 *
 * > user 要望 2026-09-07:「**アイコン類にマテリアルデザインアイコン(woff2)を採用したい**」
 * > 「**内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * ## 🔴 リガチャを使わない ── 符号位置で置く
 *
 * ⚠ リガチャ(`home` と書くと家の絵になる)は、**書体が届く前に描くと「home」という字が
 * そのまま出ます**。同梱しても初回の 1 フレームは起きえます。
 * 🔑 **符号位置なら、最悪でも出るのは豆腐(□)**であって、**意味の読める英単語ではない** ──
 * user の要望「出ないことがないように」に、いちばん強く答える形である。
 *
 * ## ⚠ 書体は**部分集合を同梱する**(外から取りに行かない)
 *
 * `src/styles/fonts/pkc-symbols.woff2` は**ここに並ぶ絵だけ**を含む版で、**6,180 バイト**。
 * ⚠ 素の Material Symbols は **5.37 MB**(4,284 種の可変書体)なので、**868 分の 1** である。
 * 🔑 作り直しは `npm run icons:font`(`scripts/build-icon-font.mjs`)── ⚠ **絵を足したら
 * 必ず回す**(回さないと、その絵だけ豆腐になる)。門は `tests/features/icon-symbols.test.ts`。
 *
 * ## ⚠ 置き換えで失ったもの(#770 の記録。CLAUDE.md §10「置き換えの作法」)
 *
 * 直す前は 24×24 の inline SVG で、**同じ絵の中で 2 色**(`solid` / `soft`)を塗り分け、
 * 線の太さを CSS px で決めていた。書体にすると:
 *
 * | 直す前 | いま |
 * |---|---|
 * | 絵の中で 2 色(31 本の path が使っていた) | 🔴 **失う** ── 書体は絵ごとに 1 色 |
 * | 線の太さを CSS px で固定 | 失う ── 書体の太さは `wght` 軸(この版は **500** で焼いてある) |
 * | 危険・種別の色 | 🟢 保つ(`color` が全体に当たる) |
 * | 書体が要らない(必ず描ける) | 同梱 + 符号位置で**実質は保つ**(上) |
 *
 * ⚠ **これが分かったら覆る**:2 色の塗り分けが「見分けに要る」と分かったとき
 * (そのときは `FILL` 軸の版をもう 1 つ焼いて、絵ごとに選ぶ)。
 */

/** 図案の名前(PKC 側の語)。⚠ **画面に出さない**(内部語)。 */
export type IconName = keyof typeof PKC_SYMBOLS;

/**
 * 図案名 → Material Symbols の絵の名前と符号位置。
 *
 * ⚠ **`icon` は絵の名前**(作り直しの script が使う)、**`cp` は描くときに使う符号位置**。
 *   🔑 2 つ持つのは二重表現ではない ── 片方は**焼く側**、もう片方は**描く側**が読む。
 *   ⚠ 食い違うと豆腐になるので、`tests/features/icon-symbols.test.ts` が
 *   **同梱した書体の中身と**突き合わせる(名前の表ではなく、**配る物**と比べる)。
 */
export const PKC_SYMBOLS = {
  settings: { icon: 'settings', cp: 0xe8b8 },
  flag: { icon: 'flag', cp: 0xf0c6 },
  help: { icon: 'help', cp: 0xe8fd },
  search: { icon: 'search', cp: 0xef7a },
  'arrow-in': { icon: 'download', cp: 0xf090 },
  'arrow-out': { icon: 'upload', cp: 0xf09b },
  'arrow-down': { icon: 'arrow_downward', cp: 0xe5db },
  archive: { icon: 'archive', cp: 0xe149 },
  globe: { icon: 'public', cp: 0xe80b },
  page: { icon: 'description', cp: 0xe873 },
  printer: { icon: 'print', cp: 0xe8ad },
  broom: { icon: 'mop', cp: 0xe28d },
  plus: { icon: 'add', cp: 0xe145 },
  clip: { icon: 'attach_file', cp: 0xe226 },
  pencil: { icon: 'edit', cp: 0xf097 },
  check: { icon: 'check', cp: 0xe668 },
  close: { icon: 'close', cp: 0xe5cd },
  clock: { icon: 'schedule', cp: 0xefd6 },
  trash: { icon: 'delete', cp: 0xe92e },
  list: { icon: 'list', cp: 0xe896 },
  folder: { icon: 'folder', cp: 0xe2c7 },
  'folder-smart': { icon: 'folder_special', cp: 0xe617 },
  stack: { icon: 'layers', cp: 0xe53b },
  apps: { icon: 'apps', cp: 0xe5c3 },
  timeline: { icon: 'timeline', cp: 0xe922 },
  grid: { icon: 'grid_on', cp: 0xe3ec },
  box: { icon: 'inbox', cp: 0xe156 },
  'check-box': { icon: 'check_box', cp: 0xe9de },
  form: { icon: 'assignment', cp: 0xe85d },
  play: { icon: 'play_arrow', cp: 0xe037 },
  'chevron-down': { icon: 'expand_more', cp: 0xe5cf },
  'chevron-up': { icon: 'expand_less', cp: 0xe5ce },
  'chevron-left': { icon: 'chevron_left', cp: 0xe5cb },
  'chevron-right': { icon: 'chevron_right', cp: 0xe5cc },
  calendar: { icon: 'calendar_month', cp: 0xebcc },
  dot: { icon: 'circle', cp: 0xef4a },
  person: { icon: 'person', cp: 0xf0d3 },
  mic: { icon: 'mic', cp: 0xe31d },
  monitor: { icon: 'monitor', cp: 0xef5b },
  stop: { icon: 'stop', cp: 0xe047 },
} as const satisfies Readonly<Record<string, { readonly icon: string; readonly cp: number }>>;

/** 図案名の全数。⚠ 表から引く(手で並べない ── 足した日に片方だけ古くなる)。 */
export const ICON_NAMES = Object.keys(PKC_SYMBOLS) as readonly IconName[];

/**
 * 🔴 **符号位置を字に変える口は置かない**(2026-09-11)。
 *
 * ⚠ 1 稿目には `symbolChar(name)` が在り、器の `textContent` に 1 文字を入れていた ──
 *   それが**ボタン丸ごとの `textContent` に目に見えない 1 文字を混ぜ**、文言を読む側を
 *   静かに外した(全量 smoke が 5 件落ちて判明)。
 * 🔑 いま絵を出すのは **CSS だけ**(`src/styles/icons.generated.css` の
 *   `::before { content }`。`npm run icons:font` がこの表から焼く)。
 * ⚠ ここに字を作る口を戻すと、**また器へ入れる道ができる** ── だから置かない。
 *   `icons.ts` は名前(`data-pkc-symbol`)しか扱わない。
 */
