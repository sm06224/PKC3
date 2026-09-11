/**
 * ボタンの図案 ── **経緯**(絵文字 → 単色 SVG → **書体**)。
 *
 * 🔴 **いまの実装は「Material Symbols の部分集合(woff2)の 1 文字」である。**
 *   ⚠ この節は**なぜそうなったか**だけを残す ── 実装そのものは下の `setIcon` を読む。
 *   ⚠ 2026-09-11 に**ここを直し忘れていた**(着地前レビュー 6):この上の段落は
 *     「🔑 だから **inline SVG で描く**」「`createElementNS` は parser を通らない」と
 *     書いたままで、**file の中で正面から矛盾していた**。
 *     🔑 CLAUDE.md 2026-08-29「**中身を足したら冒頭の要約も直す**」── 直さないと、
 *     次に読む人が冒頭だけ読んで**逆の理解**をする。
 *
 * ## ① 絵文字をやめた(P9 段③)
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
 *     **症状**を抑えていたが、原因は残っていた(OS が変われば別の書体が来る)
 *
 * ## ② 単色 SVG をやめた(#770 段①、2026-09-11)
 *
 * > user 要望 2026-09-07:「**アイコン類にマテリアルデザインアイコン(woff2)を
 * > 採用したい / 内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * 🔑 **①の 2 つの理由は、書体を同梱すれば消える** ── 単色で、字幅が一定で、
 *   OS ごとの差が無い(**こちらが配る 1 つの書体**しか使わない)。
 * ⚠ 代わりに依存が 1 つ増えた:「**その書体が届いていること**」──
 *   だから同梱し(外から取りに行かない)、`font-display: block` にしてある。
 * 🔴 **リガチャは使わない。符号位置で置く。** リガチャだと書体が届く前に
 *   `settings` という**英単語がそのまま出る** ── 符号位置なら最悪でも**豆腐(□)**で、
 *   読めてしまう字にはならない(user の「出ないことがないように」への答え)。
 *
 * ## ③ ルールは緩めてある(P10、user 指示 2026-08-05)
 *
 * > 「アイコンのルールは電子カルテの導入を過剰にルール化したせいで**無味**に
 * >  なっています。私はそれを望みません。ルールを変え、**みやすく使いやすい**のを
 * >  心がけてください」
 *
 * ⚠ 最初の版は「地は無彩色、色は情報にだけ」を**図案にまで機械適用**していたが、
 *   あの指示は**地**の話で、図案を漂白しろという意味ではない。
 *   🔑 **意味を持つ色は使う** ── 種別(何のノートか)と危険(消える操作)は情報である。
 *   値は CSS 側の token が決め、`currentColor` の仕組みをそのまま使う。
 * ⚠ **失ったもの**(書体にしたので取り戻せない)は `symbols.ts` の表に書いてある
 *   ── 絵の中の 2 色(`solid` / `soft`)と、線の太さの px 固定。
 * ⚠ 図案だけのボタンを作らない ── 意味は隣の**文字**が持つ。
 */

import type { IconName } from '@features/icon/symbols';

export type { IconName };

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
  'set-view:query': 'list',
  /**
   * ⚠ **`set-view:dual` は置かない**(2026-09-05 に落とした)── 2 ペインは上の帯
   * (`VIEW_BUTTONS`)ではなく**アプリのタイル**から開くので、この鍵を引く者が
   * どこにも居なかった。上の「生きている鍵だけ置く」の実例。
   * 🔑 等値 pin は `tests/adapter/icons.test.ts`(シェルが実際に描く面と突き合わせる)。
   */
  'set-view:settings': 'settings',
  'set-view:flags': 'flag',
  'set-view:help': 'help',
  'open-palette': 'search',
  'import-file': 'arrow-in',
  /** 外部の画像を手元へ取り込む(#264 段①)── **入ってくる**向きなので取込と同じ図案。 */
  'adopt-external-images': 'arrow-in',
  'export-archive': 'archive',
  'export-html': 'globe',
  'export-portable': 'archive',
  'export-markdown': 'page',
  'export-entry-docx': 'page',
  'export-entry-pdf': 'printer',
  'purge-orphan-assets': 'broom',
  'create-entry': 'plus',
  'attach-file': 'clip',
  /** 録音・画面収録(#413)。⚠ 止めるのは**四角**(世界共通の停止)。 */
  'start-audio-capture': 'mic',
  'start-screen-capture': 'monitor',
  'stop-capture': 'stop',
  'discard-capture': 'trash',
  'start-edit': 'pencil',
  'commit-edit': 'check',
  'cancel-edit': 'close',
  'export-entry': 'arrow-out',
  // 🔑 全体の「閲覧用 HTML」(`export-html`)と**同じ図案** ── 同じ形の物である
  'export-entry-html': 'globe',
  'show-history': 'clock',
  'delete-entry': 'trash',
  // まとめてゴミ箱へ(#240 段③)── 1 件の削除と**同じ図案**(同じ意味だから)
  'delete-selected': 'trash',
  /** 図を保存(`mermaid-hydrate` が手組みしていた ⬇ をここへ寄せた)。 */
  'save-diagram': 'arrow-down',
  /** 種類を選ぶ(分割ボタンの ▼)。 */
  'create-menu': 'chevron-down',
  /** 起動(囲いの中)。 */
  'launch-asset': 'play',
  /** 素のまま起動(同一オリジン)── 地球で「外の決まりで動く」を示す。 */
  'launch-asset-raw': 'globe',
  /** 目次を見せて起動(#195)── 見せるのは**一覧**なので箇条書きの図案。 */
  'launch-asset-extension': 'list',
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
  /** 画像を別窓で見る(#192)。⚠ 「開く」の仲間なので起動と同じ図案は使わない */
  'view-asset': 'grid',
  /** 関係(#185)── 足すのは plus、消すのは close(既存の意味と揃える)。 */
  'add-relation': 'plus',
  'remove-relation': 'close',
  /**
   * タグ(#494)。⚠ **関係と同じ図案にする** ── どちらも「この 1 件に足す /
   * この 1 件から外す」なので、別の図案にすると 2 種類の物として覚え直させる。
   */
  'add-tag': 'plus',
  'untag-entry': 'close',
  /** 本文の置換(#191)── 書き換えるので鉛筆と同じ仲間の図案にする。 */
  'toggle-replace': 'pencil',
  'replace-all': 'check',
  /**
   * 🔴 **ペインの開閉の図案はここに置かない**(#609 で消した。2026-08-30)。
   *
   * ⚠ 直す前は `'toggle-pane:sidebar': 'chevron-left'` などが在ったが、
   * **`src` / `tests` 全体で参照 0 件**だった ── 掴む帯は `shell.ts` で
   * 手組みするので `iconButton` を通らず、**この山形は 1 度も画面に出ていない**。
   * 🔑 死んだ登記は「そこに在る」と次に読む人へ嘘をつくので消す
   * (帯の見た目は `app.css` の `[data-pkc-region='pane-grip']::after`)。
   */
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
  smart: 'folder-smart',
  stack: 'stack',
  attachment: 'clip',
  todo: 'check-box',
  form: 'form',
};

/** 探し方のタブ → 図案(`browse.ts` が持っていた絵文字をここへ寄せた)。 */
export const BROWSE_ICONS: Readonly<Record<string, IconName>> = {
  list: 'list',
  filer: 'folder',
  launcher: 'apps',
  schedule: 'calendar',
  contacts: 'person',
  // 🔴 録ったもの(#683 段①)── 録る口(左下の「録音」)と同じ図案にする
  captures: 'mic',
};

/**
 * 図案の器(`data-pkc-icon` の span)を作る。
 * ⚠ 器は**必ず span** ── 大きさを決めている CSS がそこに当たっている。
 * ⚠ **名前も置く**(`data-pkc-symbol`)── 符号位置は目で読めないので、
 *   検査と smoke が「どの絵か」を言えるようにする(画面には出ない)。
 */
export function iconSpan(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.setAttribute('data-pkc-icon', '');
  span.setAttribute('aria-hidden', 'true');
  setIcon(span, name);
  return span;
}

/**
 * 既に在る器の**名前**を差し替える。絵そのものは CSS の `::before` が出す。
 *
 * 🔴 **字を器に入れない**(2026-09-11、全量 smoke が 5 件落ちて判明)。
 *
 * ⚠ 1 稿目は符号位置の 1 文字を `span.textContent` へ入れていた ── 動きはするが、
 *   **ボタン丸ごとの `textContent` に目に見えない 1 文字が混ざる**。
 *   直す前は `<svg>` 要素だったので字を 1 つも持たず、**読み手はそれに頼っていた**:
 *   `toHaveText` で文言を比べる smoke が **4 本**、種別の一覧が **1 本**落ちた。
 * 🔑 だから**絵は CSS が出す**(`data-pkc-symbol` → `::before { content }`)──
 *   器の字は**空のまま**なので、読み手は 1 つも直さなくてよい
 *   (CLAUDE.md §10「器を替えても、読み取れる値を変えない」)。
 * ⚠ 規則は**焼いた書体と同じ script が作る**(`src/styles/icons.generated.css`)──
 *   符号位置を手で 2 か所に書かない(§7)。
 *
 * ⚠ **かつてここには「`textContent` で書くな」と書いてあった** ── 中身が `<svg>` 要素
 *   だった頃、`textContent` への代入は**子ごと消す**ので、一覧の行を作り直さずに種別だけ
 *   変えるとチップが**空になった**(`sidebar.ts` の patch 経路)。いまは属性 1 つなので
 *   その罠は無い ── **同じ理由で、字も入れない**。
 */
export function setIcon(span: Element, name: IconName): void {
  span.setAttribute('data-pkc-symbol', name);
}

/**
 * 🔴 **編集の出口 2 つの説明**(#716)。中央の帯(`detail.ts`)と追記欄(`append-box.ts`)の
 * 両方に同じ action のボタンが在り、字は「保存 / キャンセル」で揃えた ── 説明も
 * ここ 1 か所から引く(2 か所に書くと、片方だけ直る)。
 * ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)。
 */
export const COMMIT_EDIT_HINT = '本文を保存して編集を終えます';
export const CANCEL_EDIT_HINT = '変更を捨てて編集を終えます';

/**
 * 図案つきボタンを作る。⚠ **中身の構造を 1 か所に固定する** ── ばらばらに組むと
 * 「このボタンだけ高さが違う」が生まれる(それが user 指摘の中身)。
 * ⚠ **引数の並びを変えない**(`docs-parity` が「文言は第 2 引数」で突合している)。
 *
 * 🔑 **ボタン丸ごとの `textContent` は、文言そのものである**(#770 段①、2026-09-11)。
 * ⚠ 図案を書体にしたとき、1 稿目は器へ字を入れたので**目に見えない 1 文字**が
 *   前に付いた ── 全量 smoke が 5 件落ちて分かった。いまは絵を CSS が出すので
 *   **SVG だった頃と同じ形**に戻してある(`tests/adapter/icons.test.ts` が等値で留める)。
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

/**
 * 🔴 **その面の「主の操作」の印**(#722 P2-10。user 裁定 2026-09-06 = 案 A)。
 *
 * cowork 実測 2026-09-05:「1440px の 1 画面に押せるボタンが **50 個**、うち
 * **23 個が完全に同じ見た目**。濃い地を持つのは『いま選んでいるタブ』の 1 個だけ」──
 * つまり **どれを押せば話が進むのかが、画面から読めない**。
 *
 * 🔑 **色ではなく濃さで段を作る**(user 指示 2026-08-03「地は無彩色、色は情報にだけ」)。
 *   地を `--fg`、字を `--surface` に**反転**するだけなので、色相は 1 つも増えない。
 * ⚠ **1 つの面に 1 つだけ**。⚠ ここを増やすと段が消える(全部が主なら主は無い)ので、
 *   `tests/adapter/primary-action.test.ts` が**面ごとに 1 個以下**を全数で見る。
 * ⚠ 印を付けるのは**この関数だけ** ── 属性を直に書くと、上の全数検査が数え落とす
 *   (`tests/repo-hygiene.test.ts` が直書きを止める)。
 */
export const PRIMARY_ATTR = 'data-pkc-primary';

/** 主の操作にする。⚠ 返り値を使わなくてよい(その場で印が付く)。 */
export function markPrimary(btn: HTMLButtonElement): HTMLButtonElement {
  return setPrimary(btn, true);
}

/**
 * 印を**付け外し**する(状態で変わる面はこちらを使う)。
 *
 * 🔴 **押しても何も起きないボタンを、いちばん濃くしない**(着地前レビュー・動線 1、
 * 2026-09-06)。⚠ 「+ ノート」は `CREATE_ENTRY` が `phase !== 'ready'` を
 * **黙って捨てる**(`app-state.ts` の `CREATE_ENTRY`)ので、**編集中は押しても
 * 1 ドットも動かない** ── そこを画面でいちばん濃くすると、
 * 「濃い = 次に押す物」と教えた直後に嘘をつくことになる。
 * ⚠ **押した結果は変えていない**(黙って捨てるのは前からの穴で、別に起票した)──
 *   ここで直すのは**見え方**だけである。
 */
export function setPrimary(btn: HTMLElement, on: boolean): HTMLButtonElement {
  if (on) btn.setAttribute(PRIMARY_ATTR, '');
  else btn.removeAttribute(PRIMARY_ATTR);
  return btn as HTMLButtonElement;
}
