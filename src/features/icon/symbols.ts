/**
 * 🔴 **図案の正本**(#770 段①、2026-09-11 / #1054 段①、2026-09-25)── PKC の図案名 →
 * **Phosphor Duotone** の絵の名前と、色の系統(tone)。
 *
 * > user 要望 2026-09-07:「**アイコン類にマテリアルデザインアイコン(woff2)を採用したい**」
 * > 「**内部的にはリガチャで表示できないってことがないようにしたい**」
 * > 裁定 2026-09-25(#1046 追加の裁定):「**いまの Material のアイコンは単色で色味に
 * > 欠け、使っていて気分が上がらない。どの書体にするかはこちらのセンスで選ぶ**」
 *
 * ## 🔴 リガチャを使わない ── 符号位置で置く(変わらない方針)
 *
 * ⚠ リガチャ(`home` と書くと家の絵になる)は、**書体が届く前に描くと「home」という字が
 * そのまま出ます**。同梱しても初回の 1 フレームは起きえます。
 * 🔑 **符号位置なら、最悪でも出るのは豆腐(□)**であって、**意味の読める英単語ではない** ──
 * user の要望「出ないことがないように」に、いちばん強く答える形である。
 *
 * ## 🔴 Duotone は**絵 1 つにつき符号位置が 2 つ**(#1054 段①)
 *
 * Phosphor Duotone は「下地(underlay。薄い色)」+「線(line。濃い色)」の 2 枚重ねで
 * 1 つの絵を作る。⚠ だからここでは**符号位置を持たない** ── 焼き直すたびに
 * `scripts/build-icon-font.mjs` が**この表の並び順**から機械的に(0xE000 を起点に
 * 2 個ずつ)組み立て、`src/styles/fonts/pkc-symbols.codepoints` と
 * `src/styles/icons.generated.css` にだけ書く。
 * ⚠ **符号位置を手で 2 か所に書かない**(CLAUDE.md §7)── ここに書いても
 * 読む側(`setIcon` / CSS)はどこも読まない、二重表現になるだけである。
 *
 * ## ⚠ 書体は**部分集合を同梱する**(外から取りに行かない)
 *
 * `src/styles/fonts/pkc-symbols.woff2` は**ここに並ぶ絵だけ**を含む版。
 * 元の Phosphor Duotone(1,512 種)を `node_modules/@phosphor-icons/web` から
 * **オフラインで**(fontTools/pyftsubset)部分集合にする ── 外の網には行かない。
 * 🔑 作り直しは `npm run icons:font`(`scripts/build-icon-font.mjs`)── ⚠ **絵を足したら
 * 必ず回す**(回さないと、その絵だけ豆腐になる)。門は `tests/features/icon-symbols.test.ts`。
 *
 * ## 🔴 色の系統(tone)── 下地の色を操作の種類で塗り分ける(#1054 段①)
 *
 * 裁定(#1046 コメント 5833269607)「下地の色を操作の種類ごとに塗り分ける
 * (作る / 録る / 取り込む・保存 / 探す・集計 / システム / 危険)」に沿い、
 * 図案名ごとに 1 つの `tone` を持つ ── 値は `src/styles/tokens.css` の
 * `--pkc-tone-*` を指す(色そのものはここに書かない。CLAUDE.md「配色は tokens.css」)。
 * ⚠ **`kind`** はノートの種別チップ(`app.css` の `[data-pkc-chip='…']`)専用 ──
 * その場に出るときは chip 側の規則が underlay ごと上書きする(下記 `icons.ts` の注記)ので、
 * ここでの `kind` はチップの外で出たときの既定(= 無彩色)にすぎない。
 *
 * ### 🔴 ここの `tone` は「絵の既定値」でしかない(#1054 段①-2、2026-09-25)
 *
 * > user 裁定(解釈、#1046 の続き)「いまの色は screenshot でほぼ見えない。
 * > 色をはっきり見せつつ、落ち着いた業務画面の雰囲気は保て」
 *
 * ⚠ 直す前(段①)は`ここ`の `tone` が**そのまま生成 CSS
 * (`icons.generated.css` の `[data-pkc-icon][data-pkc-symbol='…']`)へ焼かれ**、
 * **絵 1 つに tone は 1 つ**しか持てなかった。⚠ しかし同じ絵(`page`)が
 * 「種別チップの text」でも「Word 書き出し」でも使われるように、**同じ絵が
 * 別の action で別の意味を持つ**ことがある。
 * 🔑 だから tone の**最終決定権は `icons.ts` の `ACTION_TONES`**(action → tone)
 * に移した ── ここの `tone` は「その絵が単体で(chip でも action 上書きでも
 * ないときに)出る既定値」でしかない。実際に画面へ出る色は
 * `iconButton` / `iconSpan` が組む `data-pkc-tone` 属性を CSS(`app.css` の
 * 7 本の `[data-pkc-icon][data-pkc-tone='…']`)が読んで決める
 * (生成 CSS はもう tone を持たない ── 符号位置の `content` だけを焼く)。
 *
 * ## ⚠ 置き換えで失ったもの(#770 の記録。CLAUDE.md §10「置き換えの作法」)
 *
 * 単色 SVG だった頃は絵の中で 2 色を塗り分け、線の太さを CSS px で決めていた。
 * Material の単色書体にしたときに一度失い(#770 段①)、今回 Duotone で**下地の色**を
 * 取り戻した ── ただし**絵ごとの塗り分け**(2026-09-11 版の表の注記)ではなく、
 * **操作の種類ごと**の塗り分けである(元の 2 色とは軸が違う)。
 */

/** 図案の名前(PKC 側の語)。⚠ **画面に出さない**(内部語)。 */
export type IconName = keyof typeof PKC_SYMBOLS;

/**
 * 下地の色の系統。値そのものは `src/styles/tokens.css` の `--pkc-tone-*`。
 * ⚠ **増やすときは tokens.css に対応する変数を足す**
 * (`tests/features/icon-symbols.test.ts` が全数で突き合わせる)。
 */
export type IconTone =
  | 'create' // 作る(足す・書く・確定する)
  | 'capture' // 録る(録音・画面収録・計る)
  | 'io' // 取り込む・保存(入出力・書き出し・添付)
  | 'find' // 探す・集計(検索・履歴・グラフ)
  | 'system' // システム(設定・鍵・翻訳)
  | 'danger' // 危険(消える操作)
  | 'kind' // ノートの種別チップ専用(既定は無彩色。チップの規則が上書きする)
  | 'neutral'; // どれにも当たらない(アプリの目印など、情報を持たない絵)

/**
 * 図案名 → **Phosphor Duotone** の絵の名前と tone。
 *
 * ⚠ **`icon` は Phosphor 側の絵の名前**(`ph-duotone ph-<icon>` に対応。
 * `scripts/build-icon-font.mjs` が焼くときに使う)。
 * ⚠ 食い違うと豆腐になるので、`tests/features/icon-symbols.test.ts` が
 * **同梱した書体の目録と**突き合わせる。
 */
export const PKC_SYMBOLS = {
  settings: { icon: 'gear', tone: 'system' },
  flag: { icon: 'flag', tone: 'system' },
  help: { icon: 'question', tone: 'system' },
  search: { icon: 'magnifying-glass', tone: 'find' },
  'arrow-in': { icon: 'tray-arrow-down', tone: 'io' },
  'arrow-out': { icon: 'tray-arrow-up', tone: 'io' },
  'arrow-down': { icon: 'arrow-down', tone: 'io' },
  archive: { icon: 'archive', tone: 'io' },
  globe: { icon: 'globe', tone: 'io' },
  page: { icon: 'file-text', tone: 'kind' },
  printer: { icon: 'printer', tone: 'io' },
  /**
   * 🔴 **PowerPoint 書き出しの絵**(#1054 段①-2、2026-09-25)。⚠ 直す前は
   *   書き出しの中で唯一絵が無かった(review 指摘)。Word(`page`)/ PDF(`printer`)
   *   と並ぶ形にする。
   */
  presentation: { icon: 'presentation', tone: 'io' },
  broom: { icon: 'broom', tone: 'system' },
  plus: { icon: 'plus', tone: 'create' },
  clip: { icon: 'paperclip', tone: 'kind' },
  pencil: { icon: 'pencil-simple', tone: 'create' },
  check: { icon: 'check', tone: 'create' },
  close: { icon: 'x', tone: 'neutral' },
  clock: { icon: 'clock', tone: 'find' },
  trash: { icon: 'trash', tone: 'danger' },
  list: { icon: 'list', tone: 'find' },
  folder: { icon: 'folder', tone: 'kind' },
  'folder-smart': { icon: 'folder-star', tone: 'kind' },
  stack: { icon: 'stack', tone: 'kind' },
  apps: { icon: 'squares-four', tone: 'kind' },
  timeline: { icon: 'notebook', tone: 'kind' },
  grid: { icon: 'table', tone: 'kind' },
  box: { icon: 'tray', tone: 'io' },
  'check-box': { icon: 'check-square', tone: 'kind' },
  form: { icon: 'clipboard-text', tone: 'kind' },
  play: { icon: 'play', tone: 'capture' },
  'chevron-down': { icon: 'caret-down', tone: 'neutral' },
  'chevron-up': { icon: 'caret-up', tone: 'neutral' },
  'chevron-left': { icon: 'caret-left', tone: 'neutral' },
  'chevron-right': { icon: 'caret-right', tone: 'neutral' },
  calendar: { icon: 'calendar-dot', tone: 'find' },
  dot: { icon: 'circle', tone: 'neutral' },
  person: { icon: 'user', tone: 'neutral' },
  mic: { icon: 'microphone', tone: 'capture' },
  monitor: { icon: 'monitor-play', tone: 'capture' },
  stop: { icon: 'stop', tone: 'capture' },
  /**
   * 🔴 **ここから下は「アプリの目印」用**(#770 段②、2026-09-12)。
   *
   * > user 要望 2026-09-07:「**アプリで使えるアイコンにも使用したい**」
   *
   * ⚠ ほとんどは `tone: 'neutral'`(情報を持たない、選ばせるだけの目印)。
   */
  terminal: { icon: 'terminal', tone: 'neutral' },
  computer: { icon: 'desktop', tone: 'neutral' },
  phone: { icon: 'device-mobile', tone: 'neutral' },
  code: { icon: 'code', tone: 'neutral' },
  database: { icon: 'database', tone: 'neutral' },
  tools: { icon: 'wrench', tone: 'system' },
  calculator: { icon: 'calculator', tone: 'neutral' },
  chart: { icon: 'chart-bar', tone: 'find' },
  dashboard: { icon: 'gauge', tone: 'find' },
  note: { icon: 'note', tone: 'neutral' },
  book: { icon: 'book', tone: 'neutral' },
  news: { icon: 'newspaper', tone: 'neutral' },
  mail: { icon: 'envelope-simple', tone: 'neutral' },
  chat: { icon: 'chat-circle', tone: 'neutral' },
  timer: { icon: 'timer', tone: 'capture' },
  map: { icon: 'map-trifold', tone: 'neutral' },
  flight: { icon: 'airplane-tilt', tone: 'neutral' },
  music: { icon: 'music-notes', tone: 'neutral' },
  movie: { icon: 'film-strip', tone: 'neutral' },
  camera: { icon: 'camera', tone: 'capture' },
  palette: { icon: 'palette', tone: 'neutral' },
  game: { icon: 'game-controller', tone: 'neutral' },
  cart: { icon: 'shopping-cart', tone: 'neutral' },
  money: { icon: 'money', tone: 'neutral' },
  work: { icon: 'briefcase', tone: 'neutral' },
  school: { icon: 'graduation-cap', tone: 'neutral' },
  home: { icon: 'house', tone: 'neutral' },
  food: { icon: 'fork-knife', tone: 'neutral' },
  sunny: { icon: 'sun', tone: 'neutral' },
  science: { icon: 'flask', tone: 'neutral' },
  pets: { icon: 'paw-print', tone: 'neutral' },
  fitness: { icon: 'barbell', tone: 'neutral' },
  star: { icon: 'star', tone: 'system' },
  key: { icon: 'key', tone: 'system' },
  link: { icon: 'link', tone: 'io' },
  translate: { icon: 'translate', tone: 'system' },
  /**
   * 🔴 **ここから下は #1054 段② が使う**(2026-09-25。3 つの帯の作り替えで使う予定)。
   * ⚠ この段(段①)では**まだどこからも参照しない** ── 書体と表に用意しておくだけ。
   */
  copy: { icon: 'copy', tone: 'io' },
  move: { icon: 'arrow-square-right', tone: 'io' },
  'folder-plus': { icon: 'folder-plus', tone: 'create' },
  'note-plus': { icon: 'note-pencil', tone: 'create' },
  eye: { icon: 'eye', tone: 'find' },
  snippet: { icon: 'text-aa', tone: 'neutral' },
} as const satisfies Readonly<Record<string, { readonly icon: string; readonly tone: IconTone }>>;

/**
 * 🔴 **その字は図案の名前か**(#770 段②、2026-09-12)。
 *
 * アプリのタイルの目印(`attachment.app_icon`)は、**絵文字 1 字**でも
 * **図案の名前**でも受ける ── どちらかを見分けるのがここである。
 *
 * ⚠ **丸ごと一致だけ**にする。部分一致や前方一致にすると、目印に打った
 *   ただの字(`ma`)まで絵に化ける ── **打った字がそのまま出る**のが既定で、
 *   化けるのは**名前を丸ごと書いたとき**だけにする。
 * ⚠ 符号位置を返す口は作らない(下の注記)── これは**名前を検める**だけである。
 */
export function isIconName(raw: string): raw is IconName {
  return Object.prototype.hasOwnProperty.call(PKC_SYMBOLS, raw);
}

/** 図案名の全数。⚠ 表から引く(手で並べない ── 足した日に片方だけ古くなる)。 */
export const ICON_NAMES = Object.keys(PKC_SYMBOLS) as readonly IconName[];

/**
 * 🔴 **符号位置を字に変える口は置かない**(2026-09-11)。
 *
 * ⚠ 1 稿目には `symbolChar(name)` が在り、器の `textContent` に 1 文字を入れていた ──
 *   それが**ボタン丸ごとの `textContent` に目に見えない 1 文字を混ぜ**、文言を読む側を
 *   静かに外した(全量 smoke が 5 件落ちて判明)。
 * 🔑 いま絵を出すのは **CSS だけ**(`src/styles/icons.generated.css` の
 *   `::before` / `::after` の `content`。`npm run icons:font` がこの表から焼く)。
 * ⚠ ここに字を作る口を戻すと、**また器へ入れる道ができる** ── だから置かない。
 *   `icons.ts` は名前(`data-pkc-symbol`)しか扱わない。
 */
