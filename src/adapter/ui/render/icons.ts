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
 * 🔑 だから **inline SVG で描く**。大きさを枠が決めるので書体に依存しない。
 *
 * 🔴 **ルールを緩めた**(P10、user 指示 2026-08-05):
 * > 「アイコンのルールは電子カルテの導入を過剰にルール化したせいで**無味**に
 * >  なっています。私はそれを望みません。ルールを変え、**みやすく使いやすい**のを
 * >  心がけてください」
 *
 * 最初の版は「地は無彩色、色は情報にだけ」を**図案にまで機械適用**し、色属性を
 * 1 つでも持ったら test で落とすところまで作った ── あの指示は**地**の話で、
 * 図案を漂白しろという意味ではない。改めた 3 点:
 *  ① **塗りを使う**(`data-pkc-fill`)── 中空の細線だけだと 13〜16px で泥になる。
 *     ⚠ 色そのものは書かない。**意味の名前**(solid / soft)だけ置き、値は CSS が決める
 *  ② **線の太さを CSS px で決める**(`vector-effect: non-scaling-stroke`)──
 *     viewBox 24 に 1.75 だと、設定 0.97px / チップ 1.17px と**場所によって細さが違う**
 *  ③ **意味を持つ色は使う** ── 種別(何のノートか)と危険(消える操作)は情報である。
 *     色は CSS 側の token で、`currentColor` の仕組みはそのまま使う
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
 * 図案の 1 本。文字列は線だけ、`{ d, fill }` は**面を持つ**。
 * ⚠ `fill` は**意味の名前**であって色ではない ── 実際の塗りは CSS が決める
 * (`solid` = べた塗り / `soft` = 薄い面 + 輪郭)。
 */
type IconPath = string | { readonly d: string; readonly fill: 'solid' | 'soft' };

/**
 * 図案の幾何。**24×24 の枠**に、塗りなしの線だけで描く。
 * ⚠ 「図を保存」は font-size 11.5px なので実寸 13px まで縮む ──
 * 線の太さは CSS 側で 1.75 に決めてある(細くすると消える)。
 */
/**
 * 図案の幾何。**24×24 の枠**に描く。
 *
 * 🔴 **13〜16px で読めることが最優先**(P10)。実測の教訓:
 *  - 平行線は**中心間 3 単位以上**空ける ── 2.6 単位以下は 1 本の灰色の帯に融ける
 *    (旧 `globe` の経線 2 本、旧 `form` の 3 本罫、旧 `grid` の 3 行が該当)
 *  - 中空の小さい形は**塗る** ── 16px の中空は泥になる(旧 `apps` の 4 枚、節の丸)
 *  - path は **4 本以下**を目安に。細部は縮めるのではなく**捨てる**
 * ⚠ 塗りは `{ d, fill }` で**意味だけ**書く(`solid` = べた / `soft` = 薄い面)。
 *   色と不透明度は CSS が決める ── ここに色を書かない。
 */
const ICON_PATHS: Readonly<Record<string, readonly IconPath[]>> = {
  /** 設定 ── つまみ。⚠ 歯車は 13px で溝が消える(ここは画面で最小の図案) */
  settings: [
    'M4 8.5h16',
    'M4 15.5h16',
    { d: 'M12.8 8.5a2.3 2.3 0 104.6 0 2.3 2.3 0 00-4.6 0z', fill: 'solid' },
    { d: 'M6.6 15.5a2.3 2.3 0 104.6 0 2.3 2.3 0 00-4.6 0z', fill: 'solid' },
  ],
  /**
   * フラグ ── 旗(P11)。⚠ 竿は 1 本、布は塗る(中空だと 16px で泥になる)。
   * 設定の「つまみ」と**形が似ないもの**にした ── 隣に並ぶので、輪郭で区別が付く必要がある。
   */
  flag: ['M6 3.5v17', { d: 'M7.5 4.5h11l-2.6 3.8 2.6 3.8h-11z', fill: 'solid' }],
  /**
   * ヘルプ ── 丸の中の「?」(P11)。⚠ 本のかたちは 13px で綴じ目と本文線が
   * 融けるので採らない。点は**塗る**(中空だと泥になる)。
   */
  help: [
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z',
    'M9.4 9.4a2.7 2.7 0 115.2 1c0 1.8-2.6 2.1-2.6 3.9',
    { d: 'M10.6 17.4a1.4 1.4 0 102.8 0 1.4 1.4 0 00-2.8 0z', fill: 'solid' },
  ],
  /** 取り込む ── 受け皿へ下向き。 */
  'arrow-in': ['M12 3.5v9', { d: 'M7.5 11l4.5 5 4.5-5z', fill: 'solid' }, 'M4 18v2.5h16V18'],
  /** 書き出す ── 受け皿から上向き。 */
  'arrow-out': ['M12 15.5v-9', { d: 'M7.5 8l4.5-5 4.5 5z', fill: 'solid' }, 'M4 18v2.5h16V18'],
  /** 下向きの矢印(図を保存)。 */
  'arrow-down': ['M12 4v9', { d: 'M6.5 11.5l5.5 6 5.5-6z', fill: 'solid' }],
  /** バックアップ ── 蓋つきの箱。⚠ 留め具は捨てた(13px で潰れる) */
  archive: [{ d: 'M3 5.5h18v4.5H3z', fill: 'soft' }, 'M5 10v10.5h14V10'],
  /** 閲覧用 HTML ── 地球。⚠ 経線は **1 本**(2 本は 2.4px で融ける) */
  globe: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z', 'M3.5 12h17', 'M12 3.5c3.2 4.6 3.2 12.4 0 17'],
  /** ノート / Markdown ── 角の折れた紙。⚠ 本文の線は 1 本、折りは塗る */
  page: ['M6 3h8l4 4v14H6z', { d: 'M14 3l4 4h-4z', fill: 'solid' }, 'M9 14h6'],
  /** 使っていない添付を消す ── ほうき。⚠ 柄と穂をつなぐ(前は宙に浮いていた) */
  broom: ['M20 5l-8 8', { d: 'M12.5 12.5l-2 7.5L4 21l1.5-7z', fill: 'soft' }],
  /** 新規 ── 十字。 */
  plus: ['M12 5v14', 'M5 12h14'],
  /** 添付 ── クリップ。⚠ 折り返しを 1 回に(3 本並ぶと内側が 4 単位を割る) */
  clip: ['M16.5 7.5l-7 7a3.2 3.2 0 004.5 4.5l7-7a5.2 5.2 0 00-7.4-7.4l-7.6 7.6'],
  /** 編集 ── 鉛筆。⚠ 穂先を塗る(線だけだと先端が消える) */
  pencil: ['M4 20h4l11-11-4-4L4 16z', { d: 'M4 20h4l-1.5-2.5z', fill: 'solid' }],
  /** 保存(確定)── 検印。 */
  check: ['M5 13l4.5 4.5L19 7'],
  /** やめる ── 斜めの十字。 */
  close: ['M6 6l12 12', 'M18 6L6 18'],
  /** 履歴 ── 時計。 */
  clock: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z', 'M12 7.5V12l3.5 2.5'],
  /** 削除 ── ごみ箱。⚠ リブは捨て、取っ手を 4 単位に(3 単位は蓋線に溶ける) */
  trash: ['M4 7h16', 'M9 7V3.8h6V7', { d: 'M6.5 7.5l1 12.5h9l1-12.5z', fill: 'soft' }],
  /** 一覧 ── 箇条の並び。⚠ 行間 6 単位 */
  list: [{ d: 'M4 5h2v2H4z', fill: 'solid' }, 'M9 6h11', { d: 'M4 11h2v2H4z', fill: 'solid' }, 'M9 12h11', { d: 'M4 17h2v2H4z', fill: 'solid' }, 'M9 18h11'],
  /** フォルダ。⚠ タブの段差を 4 単位に(2.5 単位では消える) */
  folder: ['M3 6.5h6.5l2.5 4H21V19.5H3z'],
  /** アプリ ── 4 枚の板。⚠ 塗る(中空だと 16px で泥になる) */
  apps: [
    { d: 'M4 4h6.5v6.5H4z', fill: 'solid' },
    { d: 'M13.5 4H20v6.5h-6.5z', fill: 'solid' },
    { d: 'M4 13.5h6.5V20H4z', fill: 'soft' },
    { d: 'M13.5 13.5H20V20h-6.5z', fill: 'solid' },
  ],
  /** ログ ── 時系列(縦の線に節)。⚠ 節は塗る */
  timeline: [
    'M6 4v16',
    'M10 8.5h10',
    'M10 15h8',
    { d: 'M4 8.5a2 2 0 104 0 2 2 0 00-4 0z', fill: 'solid' },
    { d: 'M4 15a2 2 0 104 0 2 2 0 00-4 0z', fill: 'solid' },
  ],
  /** 表 ── 2×2(3 行だと最下段が 1.5px しか空かない) */
  grid: ['M4 5h16v14H4z', 'M4 12h16', 'M12 5v14'],
  /** todo(未完了)── 空の枠。 */
  box: ['M4.5 5h15v14h-15z'],
  /** todo(完了)── 面を薄く塗って**重さ**で差をつける(検印だけでは 2.6px) */
  'check-box': [{ d: 'M4.5 5h15v14h-15z', fill: 'soft' }, 'M8 12l3 3 5-6'],
  /** フォーム ── クリップボード。⚠ `page` と輪郭で分ける(前は同じ形だった) */
  form: [{ d: 'M9.5 3h5v3h-5z', fill: 'solid' }, 'M6 5.5h12V21H6z', 'M9 13h6'],
  /** 起動 ── 再生の三角(外に飛ばすのではなく「動かす」)。 */
  play: [{ d: 'M8 5.5l11 6.5-11 6.5z', fill: 'solid' }],
  /** 下向きの山(種類を選ぶ / 1 つ下へ)。 */
  'chevron-down': ['M6.5 9.5l5.5 5.5 5.5-5.5'],
  /** 上向きの山(1 つ上へ)。 */
  'chevron-up': ['M6.5 14.5l5.5-5.5 5.5 5.5'],
  /** 左向きの山(選択の戻る ── #190)。 */
  'chevron-left': ['M14.5 6.5L9 12l5.5 5.5'],
  /** 右向きの山(選択の進む)。 */
  'chevron-right': ['M9.5 6.5L15 12l-5.5 5.5'],
  /** 種類が分からないもの。 */
  dot: [{ d: 'M9.5 12a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z', fill: 'solid' }],
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
  'set-view:flags': 'flag',
  'set-view:help': 'help',
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
  /** 種類を選ぶ(分割ボタンの ▼)。 */
  'create-menu': 'chevron-down',
  /** 起動(囲いの中)。 */
  'launch-asset': 'play',
  /** 素のまま起動(同一オリジン)── 地球で「外の決まりで動く」を示す。 */
  'launch-asset-raw': 'globe',
  /** Office で開く(#88 / O3-c)── 開くのは**文書**なので紙の図案。 */
  'open-office': 'page',
  /** 元の md へ書き戻す(2026-08-05)。⚠ **外へ出す**向きなので書出しと同じ図案。 */
  'write-back-file': 'arrow-out',
  /** 並べ替え(2026-08-06。user 報告 2-10)── 同じ親の下で隣と入れ替える。 */
  'move-order-up': 'chevron-up',
  'move-order-down': 'chevron-down',
  /** 選択の履歴(#190)── ブラウザの戻る・進むと同じ図案にする。 */
  'nav-back': 'chevron-left',
  'nav-forward': 'chevron-right',
};

/**
 * 🔑 **種別を iconKey として引ける形**(P10 の分割ボタン用)。
 * `iconButton(action, label, 'archetype:text')` で種類の図案が出る ──
 * 表を 2 つ持たずに `ARCHETYPE_ICONS` を使い回す。
 */
export function archetypeIconKey(archetype: string): string {
  return `archetype:${archetype}`;
}

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
  for (const p of ICON_PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', typeof p === 'string' ? p : p.d);
    // ⚠ 色は書かない ── **意味の名前**だけ置く(塗りの値は CSS が決める)
    if (typeof p !== 'string') path.setAttribute('data-pkc-fill', p.fill);
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
  // ⚠ `archetype:<種別>` は種別の表から引く(分割ボタンが使う)── 表を 2 つ持たない
  const name = iconKey.startsWith('archetype:')
    ? (ARCHETYPE_ICONS[iconKey.slice('archetype:'.length)] ?? 'dot')
    : ACTION_ICONS[iconKey];
  // ⚠ 図案の無い action もある(追記 / 強制解放)── そこは器ごと出さない
  if (name !== undefined) btn.append(iconSpan(name));
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'label');
  text.textContent = label;
  btn.append(text);
  return btn;
}
