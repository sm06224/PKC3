/**
 * ボタンの図案(P8 段④ → **P9 段③ で絵文字を捨てた**)。
 *
 * > user 指示 2026-08-03「**アイコンや絵文字を使ってください**」
 * > 「**絵文字を使うとボタンの高さが合わないから、UI デザインとして
 * > ボタンサイズ揃えはしてください**」
 * > 「**地は無彩色、色は情報にだけ使う**」
 *
 * 🔴 **絵文字は上の 2 つの指示に同時に反する**:
 *  ① **多色**で、しかも `color` を無視する ── 情報を持たない所に色を撒き、
 *     テーマを変えても追従しない(端末風の暗い地に、明るい紙色の 📄 が乗る)
 *  ② **書体ごとに字幅と行送りが違う** ── 前の版は CSS で 1.15em の箱に押し込めて
 *     **症状**を抑えていたが、原因は残っていた(OS が変われば別の書体が来る。
 *     この環境で揃って見えることは、user の実機の保証にならない)
 *
 * 🔑 だから **単色の線画を inline SVG で描き、`stroke: currentColor` で塗る**。
 * 選択中の行(文字色が変わる)でも 9 テーマでも、器の文字色にそのまま追従する ──
 * 色の定義がここに増えない。大きさは枠が決めるので、書体に依存しない。
 *
 * ⚠ **`innerHTML` を使わない**。図案表を「HTML 文字列の表」にすると、
 * `Record<string, string>` に非リテラルの鍵が来た瞬間に markup 注入の口になる。
 * `createElementNS` は parser を通らないので、**構造的に**起きない。
 * ⚠ **`data-pkc-icon` は span に置いたまま**(SVG 自身に移さない)── 箱の大きさを
 * 決めている CSS(1.15em 固定 / 狭い幅でタブの図案を消す規則)がそのまま効き続ける。
 * ⚠ 図案だけのボタンを作らない ── 意味は隣の**文字**が持つ。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 図案の幾何。**24×24 の枠**に、塗りなしの線だけで描く。
 * ⚠ 「図を保存」は font-size 11.5px なので実寸 13px まで縮む ──
 * 線の太さは CSS 側で 1.75 に決めてある(細くすると消える)。
 */
const ICON_PATHS: Readonly<Record<string, readonly string[]>> = {
  /** 設定 ── つまみ(歯車は 13px で潰れる)。 */
  settings: ['M4 8h10', 'M18 8h2', 'M4 16h4', 'M12 16h8', 'M16 5.8v4.4', 'M9 13.8v4.4'],
  /** 取り込む ── 受け皿へ下向きの矢印。 */
  'arrow-in': ['M12 3v10', 'M8 9.5l4 4 4-4', 'M4 17v3h16v-3'],
  /** 書き出す ── 受け皿から上向きの矢印。 */
  'arrow-out': ['M12 14V4', 'M8 7.5l4-4 4 4', 'M4 17v3h16v-3'],
  /** 下向きの矢印(図を保存)。 */
  'arrow-down': ['M12 4v12', 'M7 11l5 5 5-5'],
  /** バックアップ ── 蓋つきの箱。 */
  archive: ['M3 6h18v4H3z', 'M5 10v10h14V10', 'M10 14h4'],
  /** 閲覧用 HTML ── 地球。 */
  globe: [
    'M12 3a9 9 0 100 18 9 9 0 000-18z',
    'M3 12h18',
    'M12 3c2.5 2.4 2.5 15.6 0 18',
    'M12 3c-2.5 2.4-2.5 15.6 0 18',
  ],
  /** Markdown / ノート ── 角の折れた紙。 */
  page: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  /** 使っていない添付を消す ── ほうき。 */
  broom: ['M14 4l6 6', 'M13 11l-8 8', 'M4 20l3-6 6 3-3 6z'],
  /** 新規 ── 十字。 */
  plus: ['M12 5v14', 'M5 12h14'],
  /** 添付 ── クリップ。 */
  clip: ['M16 7l-7 7a3 3 0 004.2 4.2l7-7a5 5 0 00-7-7l-7.5 7.5'],
  /** 編集 ── 鉛筆。 */
  pencil: ['M4 20h4l12-12-4-4L4 16z', 'M14 6l4 4'],
  /** 保存(確定)── 検印。 */
  check: ['M5 13l4.5 4.5L19 7'],
  /** やめる ── 斜めの十字。 */
  close: ['M6 6l12 12', 'M18 6L6 18'],
  /** 履歴 ── 時計。 */
  clock: ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 7.5V12l3.5 2.5'],
  /** 削除 ── ごみ箱。 */
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  /** 一覧 ── 箇条の並び。 */
  list: ['M4 6h1', 'M9 6h11', 'M4 12h1', 'M9 12h11', 'M4 18h1', 'M9 18h11'],
  /** フォルダ。 */
  folder: ['M3 7h6l2 2.5h10V19H3z', 'M3 7v12'],
  /** アプリ ── 4 枚の板(🚀 は業務画面の語彙ではない)。 */
  apps: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  /** ログ ── 時系列(縦の線に節)。 */
  timeline: [
    'M6 4v16',
    'M9 8h11',
    'M9 14h8',
    'M4.6 8a1.4 1.4 0 102.8 0 1.4 1.4 0 00-2.8 0z',
    'M4.6 14a1.4 1.4 0 102.8 0 1.4 1.4 0 00-2.8 0z',
  ],
  /** 表 ── 格子。 */
  grid: ['M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M12 5v14'],
  /** todo(未完了)── 空の枠。 */
  box: ['M4 5h16v14H4z'],
  /** todo(完了)── 枠つきの検印。 */
  'check-box': ['M4 5h16v14H4z', 'M8 12l3 3 5-6'],
  /** フォーム ── 記入欄のある紙。 */
  form: ['M6 3h12v18H6z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],
  /** 種類が分からないもの。 */
  dot: ['M9.5 12a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z'],
};

export type IconName = keyof typeof ICON_PATHS;

/**
 * `data-pkc-action`(または `iconKey`)→ 図案。
 *
 * ⚠ **生きている鍵だけ置く**。前の版は 22 件のうち **9 件が死んでいた**
 * (`set-view:detail` / `:filer` / `:launcher` は P8 段⑤ で上の帯から面の切替が
 * 消えて以降どこからも引かれず、`show-trash` / `restore-trash` / `purge-trash` /
 * `filer-root` / `append-section` は filer と append-box が手組みしていた)。
 * 死んだ表は「在るのに効かない」ので、次に触る人を惑わせる。
 */
export const ACTION_ICONS: Readonly<Record<string, IconName>> = {
  'set-view:settings': 'settings',
  'import-file': 'arrow-in',
  'export-archive': 'archive',
  'export-html': 'globe',
  'export-markdown': 'page',
  'purge-orphan-assets': 'broom',
  'create-entry': 'plus',
  'attach-file': 'clip',
  'start-edit': 'pencil',
  'commit-edit': 'check',
  'cancel-edit': 'close',
  'export-entry': 'arrow-out',
  'show-history': 'clock',
  'delete-entry': 'trash',
  /** 図を保存(`mermaid-hydrate` が手組みしていた ⬇ をここへ寄せた)。 */
  'save-diagram': 'arrow-down',
};

/** 種別 → 図案(一覧のチップ)。⚠ 未知の archetype は `dot`。 */
export const ARCHETYPE_ICONS: Readonly<Record<string, IconName>> = {
  text: 'page',
  textlog: 'timeline',
  spreadsheet: 'grid',
  folder: 'folder',
  attachment: 'clip',
  todo: 'check-box',
  form: 'form',
};

/** 探し方のタブ → 図案(`browse.ts` が持っていた絵文字をここへ寄せた)。 */
export const BROWSE_ICONS: Readonly<Record<string, IconName>> = {
  list: 'list',
  filer: 'folder',
  launcher: 'apps',
};

/** 図案 1 つを作る。⚠ 呼び側は**そのまま append する**(文字列にしない)。 */
export function svgIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  // 読み上げには出さない(意味は隣のラベルが持つ)。器の span にも付けてある
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // ⚠ `name` は `IconName` に縛ってあるので実行時に欠けることは無い。
  //    `?? []` は `noUncheckedIndexedAccess` を黙らせるためだけの保険
  for (const d of ICON_PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * 図案の器(`data-pkc-icon` の span)を作る。
 * ⚠ 器は**必ず span** ── 大きさを決めている CSS がそこに当たっている。
 */
export function iconSpan(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.setAttribute('data-pkc-icon', '');
  span.setAttribute('aria-hidden', 'true');
  span.append(svgIcon(name));
  return span;
}

/**
 * 既に在る器の中身を差し替える。
 *
 * 🔴 **`textContent` で書かない**。文字だった頃は `chip.textContent = glyph` で
 * 済んでいたが、中身が要素になったので `textContent` への代入は**子ごと消す** ──
 * 一覧の行を作り直さずに種別だけ変えた瞬間、チップが**空になる**
 * (`sidebar.ts` の patch 経路 ── 調査でいちばん危ないと名指しされた 1 行)。
 */
export function setIcon(span: Element, name: IconName): void {
  span.replaceChildren(svgIcon(name));
}

/**
 * 図案つきボタンを作る。⚠ **中身の構造を 1 か所に固定する** ── ばらばらに組むと
 * 「このボタンだけ高さが違う」が生まれる(それが user 指摘の中身)。
 * ⚠ **引数の並びを変えない**(`docs-parity` が「文言は第 2 引数」で突合している)。
 */
export function iconButton(action: string, label: string, iconKey = action): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', action);
  const name = ACTION_ICONS[iconKey];
  // ⚠ 図案の無い action もある(追記 / 強制解放)── そこは器ごと出さない
  if (name !== undefined) btn.append(iconSpan(name));
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'label');
  text.textContent = label;
  btn.append(text);
  return btn;
}
