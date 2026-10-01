/**
 * 🔴 **左の列の下の帯(`collection-bar`)に並ぶ操作の一覧を 1 か所で持つ**(#582)。
 *
 * ## なぜ shell から出したのか
 *
 * 左の列を畳むと、列ごと `display: none` になり、この帯のボタン(取り込む / バックアップ /
 * 操作を探す / 集計 / システム / フラグ / ヘルプ)も一緒に消える。「マウスだけで完結し、
 * キーボードは近道」(2026-08-03)に反するので、**畳んだ縁(`collapsed-edge.ts`)にも
 * 同じ操作を縦に出す**(#582、🟣 Gemini 裁定 2026-10-01 = 案 A)。
 *
 * 🔴 **登記簿を 2 つにしない**。縁は**この一覧から射影**する ── 帯と縁が別々に
 * ボタンを組むと、片方へ足したとき**もう片方から動線が消える**(#197 の裏返し)。
 * ⚠ 一覧を **関数** にしてあるのは、封印(`SEALED_VIEWS`)を**呼ぶたびに**読むため。
 * ⚠ `data-pkc-action` の名前は**既存のまま**(受け手を増やさない)。
 */
import { SEALED_VIEWS } from '@features/sealed';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';
import { COLLECTION_COMMANDS } from './commands';
import { iconButton, markBarTile } from './icons';

/**
 * 🔴 **上下の帯を撤去した**(P10、user 指示 2026-08-05
 * 「UI の上下の帯は不要だと思う。大して働いていない。設定への導線だけどこかに
 * 残す必要がある」)。
 *
 * 上の帯に載っていたのは「PKC3」の文字と設定ボタンだけだった ──
 * 現在地を出すはずの `brand-context` は**書き手が 1 つも無く**、ずっと空だった。
 * 下の帯は 99% の時間「pkc3 v3.0.0」を出していた(版はホバーと設定へ移した)。
 *
 * 設定は**左の列の下**へ移した ── そこはもともと「アプリ / ノート全体に対する
 * 操作」が並ぶ場所で、設定もその一員である。
 * ⚠ 探し方のタブには**しない** ── タブは「どう探すか」の軸で、設定は探し方ではない。
 */
const VIEW_BUTTONS: readonly { view: string; label: string }[] = [
  /**
   * 集計(#184)。⚠ **一番上**に置く ── 日々使う面であり、設定・フラグ・ヘルプ
   * (困ったときに見る面)より手前にあるべき。PKC2 は同等の面を右ペインの
   * セレクトの奥に埋め、**自動では 1 度も出ない**ままにして死なせた。
   */
  { view: 'query', label: '集計' },
  /**
   * 🔴 **2 ペインはここに置かない**(user 指摘 2026-08-19
   * 「2 ペインファイラは**アプリとして** Office のように組み込みの導線を用意しろ」)。
   *
   * ⚠ 1 稿目はここ(集計・設定・フラグ・ヘルプが並ぶ「アプリ全体の操作」)に
   * 置いたが、user が言った「組み込み」は**アプリの一覧**である ── Office と
   * 同じく `features/launcher/tiles.ts` の**組み込みタイル**が導線になった。
   * ⚠ ここに残すと同じ物の入口が 2 か所になり、「同じものが常に同じ場所にある」が
   *   崩れる(この帯は面の切替ではなく、アプリ全体の操作が並ぶ場所である)。
   * 🔑 鍵(`Alt+6`)は残す ── 近道と導線は別の軸。
   *
   * 🔴 **「設定」→「システム」に改名**(#1017 段⓪。user 裁定 2026-09-20)。
   * ⚠ 内部の id(`'settings'` / `ViewMode`)は変えない ── 変わるのは画面の字だけ。
   */
  { view: 'settings', label: 'システム' },
  // ⚠ 開発者・パワーユーザー向け(P11)。システムとは**別の面**にする(裁定 Q3)
  { view: 'flags', label: 'フラグ' },
  /**
   * ヘルプ(P11。user 指示 2026-08-07「ヘルプ画面にはマニュアル導線も含めて
   * ください」)。⚠ **一番下**に置く ── 「困ったら最後に見る場所」の位置。
   *
   * 🔴 **アプリの一覧にも「マニュアル」が在るが、こちらは消さない**(#531、2026-09-11)。
   *
   * ⚠ すぐ上の「2 ペイン」の戒めは「**同じ物の入口が 2 か所になるな**」と書いてあり、
   *   字面だけ読むとここも消す側に見える ── **消さない理由を書いておく**:
   *   ① **中身が違う**。左のこれは**面**(版・お知らせ・ショートカット・マニュアル)で、
   *      アプリの一覧のタイルは**マニュアルだけの別窓**である
   *   ② **困っている人の動線である**。ヘルプは「何かがおかしいとき」に押すので、
   *      **探させてはいけない** ── アプリの一覧まで辿らせるのは、その状況で最も遠い
   *   ③ 別窓は**ポップアップを止めている端末では開かない**。左のこれが退避先になる
   * 🔑 ここを消すのは、上の 3 つが**全部**崩れたときだけである。
   */
  { view: 'help', label: 'ヘルプ' },
] as const;

/**
 * 🔴 **鍵の一覧の id と揃える**(#1054 段②)── ここは今まで `title` を
 *   1 つも持たなかった(文字がそのまま名前だったので要らなかった)。
 *   図案だけのタイルにした以上、hover で読める説明が要る。
 */
const VIEW_HINT_COMMAND: Readonly<Record<string, string>> = {
  query: 'view-query',
  settings: 'open-settings',
  flags: 'open-flags',
  help: 'open-help',
};

/** 操作を名前で探す(#425 段①)の説明。⚠ 鍵の綴りは `applyShortcutHints` が組み立てる。 */
const PALETTE_HINT = 'できる操作を名前で絞り込んで、その場で実行します';

export interface CollectionBarItem {
  readonly action: string;
  readonly label: string;
  /** `iconButton` の第 3 引数(図案の鍵)。 */
  readonly iconKey: string;
  /** `title` をそのまま持つ物(取り込む / バックアップ)。 */
  readonly title?: string;
  /** 鍵の綴りを足す物(`applyShortcutHints` が読む)。 */
  readonly hint?: { readonly base: string; readonly command: string };
  /** `set-view` の行き先。 */
  readonly view?: string;
  /** 区切りの塊。`app` = 設定・フラグ・ヘルプなど「アプリ全体」の側。 */
  readonly group: 'main' | 'app';
}

/**
 * 帯に並ぶ物を**並び順のまま**返す。⚠ 帯と縁の**両方**がこれを読む(登記簿を 2 つにしない)。
 *
 * 🔑 並びは 取り込む / バックアップ(`COLLECTION_COMMANDS`)→ 操作を探す → 集計 / システム /
 * フラグ / ヘルプ(`VIEW_BUTTONS` から封印を除く)。
 */
export function collectionBarItems(): readonly CollectionBarItem[] {
  const out: CollectionBarItem[] = [];
  for (const { action, label, title } of COLLECTION_COMMANDS) {
    out.push({ action, label, iconKey: action, title, group: 'main' });
  }
  /**
   * 🔴 **操作を名前で探す**(#425 段①)。
   *
   * ⚠ **ボタンを先に置く**(不可侵指示「マウスだけで完結し、キーボードは近道」)──
   *   鍵(`Ctrl/⌘+Shift+P`)だけにすると**画面のどこにも無い機能**になる。
   * ⚠ 置き場は**設定・フラグ・ヘルプの隣** ── どれも「アプリ全体の操作」であり、
   *   `COLLECTION_COMMANDS`(書き出しと片づけ)とは役割が違う。あちらの表に混ぜると、
   *   `tests/adapter/collection-commands.test.ts` の「全数」の意味が濁る。
   * ⚠ 押し口は**ここのまま**(2026-09-20 user 裁定「いまのまま」)── 縁に出るのは
   *   「この一覧に在るから」であって、個別の例外を書いてはいない。
   */
  out.push({
    action: 'open-palette',
    label: '操作を探す',
    iconKey: 'open-palette',
    hint: { base: PALETTE_HINT, command: 'open-palette' },
    group: 'main',
  });
  for (const { view, label } of VIEW_BUTTONS) {
    if (SEALED_VIEWS.includes(view)) continue;
    const command = VIEW_HINT_COMMAND[view];
    out.push({
      action: 'set-view',
      label,
      iconKey: `set-view:${view}`,
      view,
      ...(command !== undefined ? { hint: { base: label, command } } : {}),
      group: 'app',
    });
  }
  return out;
}

/**
 * 🔴 **いま開いている面の印を、`data-pkc-view` を持つボタンの全部へ当てる**(#1206 D1)。
 *
 * ⚠ 探す先は**帯(左の列の中)だけでなく畳んだ縁(shell 直下)も含む** ── 直す前は左の列の
 *   中だけを探したので、列を畳んで縁の「システム」を押すと面は開くのに**縁のボタンに印が付かず**、
 *   「もう一度押すと閉じる」が分からなかった。
 * 🔑 引数は `shell` を渡す(縁は shell の子なので、列の中だけを渡すと同じ欠陥に戻る)。
 */
export function markCollectionView(scope: ParentNode, view: string): void {
  for (const btn of scope.querySelectorAll('[data-pkc-view]')) {
    if (btn.getAttribute('data-pkc-view') === view) btn.setAttribute('data-pkc-active', '');
    else btn.removeAttribute('data-pkc-active');
  }
}

/**
 * 1 つぶんのボタンを組む。⚠ **帯と縁が同じ関数で組む** ── 属性を手で写さない。
 * ⚠ 帯の出力は #582 より前と**1 バイトも変えない**(`aria-label` は縁が足す)。
 */
export function collectionBarButton(item: CollectionBarItem): HTMLButtonElement {
  const btn = iconButton(item.action, item.label, item.iconKey);
  markBarTile(btn);
  if (item.view !== undefined) {
    btn.setAttribute('data-pkc-view', item.view);
    btn.setAttribute('data-pkc-field', 'app-settings');
  }
  if (item.hint !== undefined) {
    btn.setAttribute(HINT_BASE, item.hint.base);
    btn.setAttribute(HINT_COMMAND, item.hint.command);
    btn.title = hintTitle(item.hint.base, item.hint.command);
  }
  if (item.title !== undefined) btn.title = item.title;
  return btn;
}
