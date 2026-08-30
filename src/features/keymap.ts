/**
 * ショートカットキーの正本(user 指示 2026-08-18)。
 *
 * > 「**PKC2 相当以上のショートカットキー機能とショートカットキーのカスタマイズ機能、
 * > デフォルトは PKC2 の操作感に寄せること**」
 *
 * ## なぜ「表」を作るのか(#7 型の予防)
 *
 * 直す前、キーの判定は **4 か所**に散っていた ──
 * `adapter/ui/actions/binder.ts`(全域 + 編集欄)/ `adapter/ui/render/row-swap.ts`(行の欄)/
 * `adapter/ui/render/detail.ts`(全文編集・取り消し)。同じ問いに答える口が複数あると
 * **片方だけ壊しても届かない**(CLAUDE.md §7)し、カスタマイズを載せる場所も定まらない。
 * 🔑 だから **「どのキーがどのコマンドか」だけをここへ寄せる**。実際の処理は
 * 今まで通りそれぞれの面が持つ ── 面の事情(焦点・封印・断り文)まで集めると別の泥沼になる。
 *
 * ⚠ ここは **features 層** = 純関数のみ。保存(localStorage)と `KeyboardEvent` の購読は
 * `adapter/ui/render/keymap.ts`(`editor-mode.ts` / `page-format.ts` と同じ分け方)。
 * ⚠ **flag ではない**(user 指示 2026-07-30「正規設定と分離」)。15 枠は 1 つも使わない。
 * ⚠ **URL パラメータも作らない**(user 指示 2026-08-07「クエリパラメータを抜け穴にしない」)。
 */

/** 修飾キーの状態 + 基本キー。⚠ `mod` は **Ctrl と ⌘ の両方**(下の注記)。 */
export interface Chord {
  /**
   * 🔴 **Ctrl と ⌘ を 1 つに畳む**。PKC2 も PKC3 も `ctrlKey || metaKey` で受けており、
   * mac の人は ⌘、Windows の人は Ctrl を押す ── **同じ操作の別名**である。
   * ⚠ 分けると「mac だけ効かない近道」が必ず生まれる(PKC2 が実際にそう作っていた)。
   */
  readonly mod: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** 正規化済みの基本キー(`B` / `1` / `[` / `ArrowLeft` / `F1` / `Space` …)。 */
  readonly key: string;
}

/** どの面で効くか。⚠ `global` は document で受けるので**他の全部と重なりうる**。 */
/**
 * ⚠ **`dual` を分けている理由**(2026-08-19)── 「反対のペインへ写す / 移す」は
 * **2 ペインの面にしか存在しない操作**である。`filer` に混ぜると、左の列の表に
 * 焦点があるときも設定画面に並び、押しても何も起きない鍵になる(dead key)。
 * 🔑 逆に**両方に在る操作**(開く / ゴミ箱 / 行送り)は `filer` 1 つのまま ──
 *   user に同じ操作を 2 回割り当て直させない(#273 で確立した規律)。
 */
export type KeyContext =
  | 'global'
  | 'editor'
  | 'append'
  | 'row'
  | 'live'
  | 'filer'
  | 'dual';

/**
 * 🔴 **どこで効くかの見出し**(2026-08-26 に adapter からここへ移した)。
 *
 * ⚠ user は「文脈」とは呼ばない ── **どこで効くか**で書く。
 * 🔑 **features 層に置く理由**:設定画面(`keymap-panel.ts`)だけでなく、
 *   操作を名前で探す面(#425 段①)も「なぜ押せないか」をこの字で言う ──
 *   adapter に置いたままだと、純関数側が**同じ字を書き直す**ことになる
 *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 */
/** 文脈の見出し。⚠ test が「名乗った文脈の下に出ているか」を全数で突き合わせる。 */
export const CONTEXT_LABELS: Readonly<Record<KeyContext, string>> = {
  global: '画面のどこでも',
  editor: '2 ペインの編集(原文と題名の欄)',
  append: '追記の欄',
  row: '1 面の編集(開いている行の欄)',
  live: '1 画面での編集(画面ぜんたい)',
  /**
   * ⚠ **2 ペインでも効く**(2026-08-20)── 開く / ゴミ箱 / 行送りは両方の面で
   *   同じ意味なので `filer` 1 つのままにしてある(user に同じ操作を 2 回
   *   割り当て直させない)。見出しがどちらか一方だけを名乗ると**嘘になる**。
   */
  filer: 'フォルダの一覧と 2 ペイン(行を選んでいるとき)',
  /** ⚠ こちらは**2 ペインにしか存在しない操作**だけ(反対側へ写す / 移す など)。 */
  dual: '2 ペインだけの操作(そのペインに焦点があるとき)',
};

export interface KeyCommand {
  readonly id: string;
  /** 設定画面・ヘルプに出る名前。⚠ 変えたらマニュアルも直す。 */
  readonly label: string;
  /**
   * どの面で効くか(複数可)。
   * ⚠ **複数になる理由がある** ── 書式の近道(太字 / 斜体 / リンク)は
   * 2 列の編集欄でも 1 面の行の欄でも同じ意味で効く(`binder.ts` が既にそう書いていた)。
   * 1 つに縛ると「同じ操作が 2 つの id を持つ」ことになり、設定画面に**同じ行が 2 度**出る。
   */
  readonly contexts: readonly KeyContext[];
  /** 既定の割当(複数可 = 別名)。⚠ **空にしない** ── 既定が無い口は戻し道が無い。 */
  readonly defaults: readonly string[];
  /**
   * 打っている最中(入力欄に焦点がある)でも効かせるか。既定は false。
   * ⚠ `contexts` が `editor` / `append` / `row` / `live` のものは**そもそも欄の中の話**なので
   * この項目を見ない ── 見るのは `global` だけである。
   */
  readonly whileTyping?: boolean;
  /** ヘルプに出す 1 行の説明(無ければ label だけ出す)。 */
  readonly note?: string;
}

/**
 * 🔴 **コマンド表**(= user に見える全部)。
 *
 * 既定は **PKC2 の操作感**に寄せる(user 指示)── PKC2 で `Ctrl+S` だったものは
 * PKC3 でも `Ctrl+S`。PKC2 に無かったもの(履歴の前後・ペインの開閉)は PKC3 の
 * 既存の割当をそのまま既定にする(2026-08 に着地済みで、マニュアルにも載っている)。
 *
 * ⚠ **並び順がそのまま設定画面とヘルプの並び**である(面ごとに固まるよう並べる)。
 */
export const KEY_COMMANDS: readonly KeyCommand[] = [
  // ── 全域(document で受ける)
  {
    id: 'create-entry',
    label: 'ノートを作る',
    contexts: ['global'],
    defaults: ['Mod+N'],
    note: 'いま選んでいる種類で作ります(編集中は効きません)',
  },
  {
    id: 'edit-entry',
    label: '選んでいるノートを編集する',
    contexts: ['global'],
    defaults: ['Mod+E'],
    // ⚠ 「編集」の押しボタンは**ノートを選んでいるときだけ**在る(着地前レビュー 8)
    note: 'ノートを選んでいるときだけ効きます(PKC2 の Ctrl+E と同じ手)',
  },
  {
    id: 'focus-search',
    label: '絞り込みの欄へ移る',
    contexts: ['global'],
    defaults: ['Mod+F'],
    note: '左の一覧の絞り込み欄に焦点を移します',
  },
  /**
   * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
   * ⚠ 近道であって**主の口ではない** ── 主は書式の帯のボタン(マウスだけで完結する)。
   * ⚠ `Mod+;` は表計算系の「今日を入れる」と同じ位置 ── 覚え直さなくてよい。
   */
  {
    id: 'insert-date',
    label: '日付を入れる',
    contexts: ['global'],
    defaults: ['Mod+Semicolon'],
    whileTyping: true,
    note: '編集中だけ効きます(本文の caret の位置に入ります)',
  },
  /**
   * 🔴 **ノートへのリンクを入れる**(#427 段②)。
   * ⚠ 近道であって**主の口ではない** ── 主は書式の帯のボタン(マウスだけで完結する)。
   * ⚠ `Mod+Shift+K` は `Mod+K`(リンク)の**隣**に置いた ── 用が近いので覚えやすい。
   *   ⚠ `[[` で出す形は採らない(理由は `features/entry-ref/entry-pick.ts` の冒頭)。
   */
  {
    id: 'insert-entry-link',
    label: 'ノートへのリンク',
    contexts: ['global'],
    defaults: ['Mod+Shift+K'],
    whileTyping: true,
    note: '編集中だけ効きます(題名で探して、caret の位置にリンクが入ります)',
  },
  /**
   * 🔴 **雛形を入れる**(#196 / B-2 段②-b)。
   * ⚠ 近道であって**主の口ではない** ── 主は書式の帯のボタン。
   * ⚠ `Mod+/` は「`/` で雛形」という市井の記憶に乗せてある ── ただし
   *   **打鍵に追随して出る形は採らない**(理由は `features/snippet/snippet-menu.ts`)。
   */
  {
    id: 'insert-snippet',
    label: '雛形を入れる',
    contexts: ['global'],
    defaults: ['Mod+Slash'],
    whileTyping: true,
    note: '編集中だけ効きます(本文の caret の位置に入ります)',
  },
  {
    id: 'toggle-replace',
    label: '置換の帯を開く / 閉じる',
    contexts: ['global'],
    defaults: ['Mod+H'],
    whileTyping: true,
    // ⚠ 帯は**編集中しか画面に無い**(着地前レビュー 8)── 閲覧中に押しても何も起きない
    note: '編集中だけ効きます(置換は編集している本文に効くため)',
  },
  /**
   * 🔴 **整理の面の鍵**(user 裁定 2026-08-18「**OS のファイラ動作に似せる方向で
   * 平仄も合わせて**」)。⚠ 効くのは**フォルダの表に焦点があるとき**だけ ──
   * 面をまたいで効かせると、#240 の着地前レビューで踏んだ「見えない所で印が増える /
   * 現在地が動く」を繰り返す。
   */
  {
    id: 'filer-open',
    label: '開く(フォルダなら中へ)',
    contexts: ['filer', 'dual'],
    // ⚠ `F3` は古典 4 実装(TC / DC / FAR / Krusader)の「見る」と同じ位置
    defaults: ['Enter', 'F3'],
    note: 'OS のファイラと同じ ── 行を選んで Enter(F3 でも開きます)',
  },
  {
    id: 'filer-parent',
    label: '親フォルダへ',
    contexts: ['filer', 'dual'],
    defaults: ['Backspace', 'Alt+ArrowUp'],
  },
  {
    id: 'filer-trash',
    label: '選んでいるものをゴミ箱へ',
    contexts: ['filer', 'dual'],
    // ⚠ `F8` は古典 4 実装が一致している鍵 ── 操作行にもそう書いてある
    defaults: ['Delete', 'F8'],
    note: 'ゴミ箱からいつでも戻せます(印が無ければカーソルの行)',
  },
  {
    id: 'filer-select-all',
    label: 'いま出ている行をぜんぶ選ぶ',
    contexts: ['filer', 'dual'],
    defaults: ['Mod+A'],
  },
  /**
   * 🔴 **行送り**(user 裁定 2026-08-18「**行送りに上下キーを使うは提案通りで OK**」)。
   *
   * ⚠ これが無いと、**キーボードだけでは行に到達できない** ── 焦点はマウスで
   * 1 回押さないと作れず、`Enter` / `Delete` は「近道」ですらなかった。
   * 🔑 **送ると印も動く**(OS のファイラと同じ = 焦点と選択が一致する)。
   *   ⚠ ただし**中央のノートは開き直さない** ── 開くのは `Enter` の仕事である
   *   (裁定「Enter は閲覧を開始」)。送るたびに本文を読み直すと、
   *   1 行ごとに worker 往復が起きる。
   */
  {
    id: 'filer-row-down',
    label: '次の行へ',
    contexts: ['filer', 'dual'],
    defaults: ['ArrowDown'],
    note: '2 ペインではカーソルだけが動きます(印は Space)',
  },
  {
    id: 'filer-row-up',
    label: '前の行へ',
    contexts: ['filer', 'dual'],
    defaults: ['ArrowUp'],
  },
  {
    id: 'filer-extend-down',
    label: '次の行まで選び足す',
    contexts: ['filer', 'dual'],
    defaults: ['Shift+ArrowDown'],
    note: '起点は最後に選んだ行',
  },
  {
    id: 'filer-extend-up',
    label: '前の行まで選び足す',
    contexts: ['filer', 'dual'],
    defaults: ['Shift+ArrowUp'],
  },
  /**
   * 🔴 **2 ペインだけの鍵**(2026-08-19 の作り直し。設計 doc §3-3)。
   *
   * ⚠ 割当は古典 4 実装(Total Commander / Double Commander / FAR / Krusader)で
   *   **一致しているもの**を採った ── `F5 写す / F6 移す / F7 作る / F8 消す`。
   * 🔑 **操作行のラベルはこの表から作る**(Krusader 方式)── user が鍵を変えたら
   *   画面の字も追従する。⚠ 直書きすると、変えた瞬間に**画面が嘘をつく**。
   */
  {
    id: 'dual-mark',
    label: '印を付ける / 外して次の行へ',
    contexts: ['dual'],
    defaults: ['Space', 'Insert'],
    note: 'カーソルは印と別です ── 見て回るのは矢印、選ぶのは Space',
  },
  {
    id: 'dual-copy-to-other',
    label: '反対のペインへ写す',
    contexts: ['dual'],
    defaults: ['F5'],
    note: '元は残ります(印が無ければカーソルの行)',
  },
  {
    id: 'dual-move-to-other',
    label: '反対のペインへ移す',
    contexts: ['dual'],
    defaults: ['F6'],
    note: '印が無ければカーソルの行が動きます',
  },
  {
    id: 'dual-rename',
    label: '名前を打ち替える',
    contexts: ['dual'],
    defaults: ['F2'],
  },
  {
    id: 'dual-new-folder',
    label: 'いまの場所にフォルダを作る',
    contexts: ['dual'],
    defaults: ['F7'],
  },
  /**
   * 🔴 **整理の面で、入れ物だけでなく中身も作れるようにする**(#273)。
   *
   * ⚠ 直す前は `dual-new-folder` しか無く、**「フォルダは作れるがノートは作れない」**
   *   という非対称だった ── 整理の途中で「ここに 1 枚メモを置きたい」と思っても、
   *   左の列へ戻って作り、開き直して移す、という 3 手が要った。
   * 🔑 鍵は **`Shift+F4`** ── Total Commander / Krusader が「新しいテキスト file」に
   *   割り当てている手であり、`F7`(フォルダ)と隣り合わない
   *   (⚠ 隣り合わせると、押し間違いで**別の種類**ができる)。
   */
  {
    id: 'dual-new-note',
    label: 'いまの場所にノートを作る',
    contexts: ['dual'],
    defaults: ['Shift+F4'],
    note: '作っても本文の面へは移りません(整理を続けられます)',
  },
  {
    id: 'dual-other-pane',
    label: '反対のペインへ移る',
    contexts: ['dual'],
    defaults: ['Tab'],
  },
  {
    id: 'view-detail',
    label: '本文の面へ',
    contexts: ['global'],
    defaults: ['Alt+1'],
    note: 'PKC2 の Alt+数字(面の切替)と同じ発想',
  },
  {
    id: 'view-query',
    label: '集計の面へ',
    contexts: ['global'],
    defaults: ['Alt+2'],
  },
  {
    /**
     * 🔴 **段組みを順ぐりに変える**(#522。user 指示 2026-08-28
     * 「**段組表示を表示変更導線をセンターペインもしくはショートカット、
     * コンテキストメニューに用意したいくらいには気に入った**」)。
     *
     * 🔑 **常設の物を増やさない**(#501「増えすぎたボタンを整理する」と逆向きに
     *   しない)── 読みながら押せて、押した所で**いま何段になったか**を言う。
     * ⚠ 押すたび **1 → 2 → 3 → 4 → 1** と回る。設定画面の並びと同じ順である。
     */
    id: 'cycle-read-columns',
    label: '本文の段組みを切り替える',
    contexts: ['global'],
    defaults: ['Alt+C'],
    note: '押すたび 1 段 → 2 段 → 3 段 → 4 段 と回ります',
  },
  {
    id: 'open-settings',
    label: '設定の面へ',
    contexts: ['global'],
    defaults: ['Alt+3', 'Mod+Comma'],
    /**
     * 🔴 **わきの面は打鍵中でも開く**(user 目線レビュー U-8、2026-08-22)。
     *
     * ⚠ 直す前は**4 つのわきの面のうち 2 つ**(`open-flags` / `open-help`)しか
     *   名乗っていなかった ── マウスでは 4 つとも開くのに、鍵では 2 つだけ。
     *   user 裁定 2026-08-08「ノートを映さない面は編集中でも開ける」は
     *   **面の側では守られているのに、鍵の側で落ちていた**(§7 の非対称)。
     * ⚠ 名乗りは**通行証ではない** ── 門は「名乗る **かつ** 和音が文字を打たない」
     *   の 2 条件なので、`Alt+3` は名乗っても通らない(`typesCharacter` が真)。
     *   実際に効くのは `Mod+Comma` のほう。⚠ だから「Alt+3 で開けます」と
     *   書いてはいけない(マニュアルを併せて直した)。
     * 🔑 それでも名乗る意味は在る ── user が**割当を変えた**とき、
     *   文字を打たない鍵にすれば即座に効く。
     */
    whileTyping: true,
    note: '文字を打っている間に効くのは Mod+, のほうです(Alt+3 は文字が入るキーなので、打っている間は効きません)',
  },
  {
    id: 'open-flags',
    label: 'フラグの面へ',
    contexts: ['global'],
    defaults: ['Alt+4', 'F12'],
    whileTyping: true,
    note: 'PKC2 の F12(Flags Inspector)と同じ手',
  },
  /**
   * 🔴 **操作を名前で探して実行する**(#425 段①)。
   *
   * ⚠ **一覧を新しく作らない** ── 出るのは**この表そのもの**である。
   *   パレット専用の配列を別に持つと、鍵の一覧・ヘルプ・パレットで**別の答え**が
   *   出る(PKC2 がまさにそれで 2 件ズレた ── `keymap-panel.ts` 冒頭の記録)。
   * ⚠ 既定は **PKC2 と同じ `Ctrl+Shift+P`**(user 指示 2026-08-18
   *   「既定は PKC2 の操作感に寄せること」)。`Mod+P`(印刷)は `REFUSED` なので使わない。
   * ⚠ `whileTyping` にしてある ── **編集中こそ呼びたい**(書式や雛形を名前で入れる)。
   *   `Mod+Shift+P` は文字を打たないので `typesCharacter` が false になり、
   *   本文に記号が入る事故は起きない。
   */
  {
    id: 'open-palette',
    label: '操作を名前で探す',
    contexts: ['global'],
    defaults: ['Mod+Shift+P'],
    whileTyping: true,
    note: 'できる操作を名前で絞り込んで、その場で実行します(PKC2 の Ctrl+Shift+P と同じ手)',
  },
  {
    id: 'open-help',
    label: 'ヘルプの面へ',
    contexts: ['global'],
    defaults: ['F1', 'Alt+5', 'Mod+Shift+Slash'],
    whileTyping: true,
    note: 'PKC2 の Ctrl+? と同じキーです。F1 は文字が入らないキーなので、文字を打っている間でも効きます',
  },
  /**
   * ⚠ **番号は末尾に足す**(#241 段⑥-a)。集計と設定の間へ差し込むと、
   * 既に `Alt+3` を体で覚えた user と、**保存済みの割当**の両方がずれる。
   */
  {
    id: 'view-dual',
    label: '2 ペインの面へ',
    contexts: ['global'],
    defaults: ['Alt+6'],
    /**
     * 🔴 **わきの面は打鍵中でも開く**(U-8。上の `open-settings` と同じ理由)。
     * ⚠ ただし既定の `Alt+6` は**文字を打つ鍵**なので、門で止まる ──
     *   打鍵中に鍵で開きたい user は、割当を文字を打たない鍵へ変える。
     *   ⚠ こちらで勝手に別の鍵を足さない(既に体で覚えた割当をずらさない)。
     */
    whileTyping: true,
    note: '別の場所を左右に開いて、まとめて移す面です(文字を打っている間にキーで開きたいときは、文字が入らないキーへ割り当て直してください)',
  },
  {
    id: 'toggle-sidebar',
    label: '左のペインを畳む / 戻す',
    contexts: ['global'],
    defaults: ['Alt+BracketLeft', 'Mod+Backslash'],
    whileTyping: true,
    note: 'PKC2 の Ctrl+\\ と同じ手',
  },
  {
    id: 'toggle-inspector',
    label: '右のペインを畳む / 戻す',
    contexts: ['global'],
    defaults: ['Alt+BracketRight', 'Mod+Shift+Backslash'],
    whileTyping: true,
    note: 'PKC2 の Ctrl+Shift+\\ と同じ手',
  },
  /**
   * 🔴 **追記欄にも鍵とパレットの口を置く**(#609。2026-08-30)。
   *
   * ⚠ 直す前、畳める面 3 つのうち**追記欄だけ**が
   * 「掴む帯は在るが、鍵もパレットも無い」状態だった:
   *
   * | 面 | 掴む帯 | 鍵 | パレット |
   * |---|---|---|---|
   * | 左 | 🟢 | 🟢 `Alt+[` | 🟢 |
   * | 右 | 🟢 | 🟢 `Alt+]` | 🟢 |
   * | 追記欄 | 🟢 | 🔴 **無い** | 🔴 **無い** |
   *
   * 🔑 **釣り合いの崩れを直して、落ちていた動線を戻す**だけである
   * (CLAUDE.md「買ってよいのは記法を 1 つも失わない整理だけ」の動線版)。
   * ⚠ パレットの行は `KEY_COMMANDS` **そのもの**から出るので、
   * ここに 1 件足すと**鍵とパレットの両方**が同時に生える(2 か所に書かない)。
   * ⚠ 鍵は `Backslash` の一族へ揃える ── 左 `Mod+\` / 右 `Mod+Shift+\` /
   * 集中 `Mod+Alt+\` と並ぶので、覚え直しが要らない。
   */
  {
    id: 'toggle-append',
    label: '追記欄を畳む / 戻す',
    contexts: ['global'],
    defaults: ['Alt+Backslash'],
    whileTyping: true,
    note: '本文の下の追記欄。畳んでも掴む帯は残る',
  },
  {
    id: 'toggle-focus-mode',
    label: '両側のペインを畳む / 戻す(集中)',
    contexts: ['global'],
    defaults: ['Mod+Alt+Backslash'],
    whileTyping: true,
    note: 'PKC2 のフォーカスモードと同じ手',
  },
  /**
   * 🔴 **「戻る」は、居る場所で意味が変わる**(#273 残件)。
   *
   * ⚠ **鍵を 2 つに割らない** ── 2 ペインの面だけ別の鍵にすると、user は
   *   「ここでは Alt+← が効かない」を憶えることになる(PKC2 が `Ctrl+N` だけ
   *   別名にして踏んだ形と同じ ── CLAUDE.md「入口は多く、判定は 1 か所」)。
   * 🔑 だから **id は 1 つのまま、文脈を足す**:
   *   - ふつうの面 … **選んだノート**を 1 つ前へ(`selection-history`)
   *   - 2 ペインの面 … **そのタブが見ていた場所**を 1 つ前へ
   * ⚠ 古典 4 実装(Total Commander / Double Commander / FAR / Krusader)も
   *   ここは `Alt+←/→` で一致している。
   */
  {
    id: 'nav-back',
    label: '戻る',
    contexts: ['global', 'dual'],
    defaults: ['Alt+ArrowLeft'],
    whileTyping: true,
    note: '2 ペインの面では、そのタブが 1 つ前に見ていた場所へ戻ります',
  },
  {
    id: 'nav-forward',
    label: '進む',
    contexts: ['global', 'dual'],
    defaults: ['Alt+ArrowRight'],
    whileTyping: true,
    note: '2 ペインの面では、戻る前に見ていた場所へ進みます',
  },
  /**
   * 🔴 **下見(選んだ行の中身を、その場で見る)**(#273 残件)。
   *
   * ⚠ 古典は `Ctrl+Q`(Total Commander / Krusader の Quick View)だが、
   *   **`Mod+Q` はブラウザが持っていく**ので当てられない(`REFUSED`)。
   * 🔑 だから **`F9`** ── この面の他の操作(F5 写す / F6 移す / F7 フォルダ /
   *   F8 ゴミ箱)と同じ**機能鍵の並び**に載る。⚠ 文字は 1 つも打たない。
   */
  {
    id: 'dual-preview',
    label: 'プレビューを出す / しまう',
    contexts: ['dual'],
    defaults: ['F9'],
    note: '本文を読みに行くので、要るときだけ出してください',
  },
  // ── 2 列の編集(原文の欄 / 題名の欄)
  {
    id: 'commit-edit',
    label: '編集を確定する',
    contexts: ['editor'],
    defaults: ['Mod+S', 'Mod+Enter'],
    note: 'ブラウザの保存ダイアログは開きません',
  },
  {
    id: 'cancel-edit',
    label: '編集をやめる',
    contexts: ['editor'],
    defaults: ['Escape'],
    note: '変換中の Escape は「変換の取り消し」なので、ここには来ません',
  },
  {
    id: 'format-bold',
    label: '太字',
    contexts: ['editor', 'row'],
    defaults: ['Mod+B'],
  },
  {
    id: 'format-italic',
    label: '斜体',
    contexts: ['editor', 'row'],
    defaults: ['Mod+I'],
  },
  /**
   * 🔴 **帯に出していない記法の入口**(#425 段②-a)。
   *
   * ⚠ 描き手は前から読めるのに、**押して入れる口が 1 つも無かった**
   *   ── 綴りを覚えている人しか使えない状態だった。
   * ⚠ **書式の帯には出さない**(既に 14 個で横に長い)。入口はこの鍵と、
   *   設定のショートカット画面での**付け替え**である。
   * 🔑 既定を **`Alt+Shift+…`** にしたのは、**いま 1 つも使っていない空き**だから
   *   ── ブラウザも取らない(`Mod+Shift+R` は再読込、`Mod+P` は印刷で `REFUSED`)。
   * ⚠ `contexts` は書式の近道と同じ 3 つ ── 2 列の編集でも 1 面の行の欄でも
   *   同じ意味で効く。
   */
  {
    id: 'format-highlight',
    label: 'ハイライト',
    contexts: ['editor', 'row'],
    defaults: ['Alt+Shift+H'],
    note: '選んだ文字を == で囲みます(色を付けたいときは ==[red]…== と書けます)',
  },
  {
    id: 'format-ruby',
    label: 'ルビ',
    contexts: ['editor', 'row'],
    defaults: ['Alt+Shift+R'],
    note: '選んだ字にふりがなを付けます([[ruby:漢字|かんじ]] の形)',
  },
  {
    id: 'format-emdot',
    label: '圏点',
    contexts: ['editor', 'row'],
    defaults: ['Alt+Shift+E'],
    note: '選んだ字の上に点を打ちます(^^ で囲みます)',
  },
  {
    id: 'format-strike',
    label: '打ち消し',
    contexts: ['editor', 'row'],
    defaults: ['Alt+Shift+X'],
    note: '選んだ字に取り消し線を引きます(~~ で囲みます)',
  },
  {
    id: 'format-link',
    label: 'リンク',
    contexts: ['editor', 'row'],
    defaults: ['Mod+K'],
  },
  // ── 追記の欄
  {
    id: 'append-send',
    label: '追記を送る',
    contexts: ['append'],
    defaults: ['Mod+Enter'],
    note: '追記の欄の中だけ',
  },
  // ── 1 面(ライブ)の行の欄
  {
    id: 'row-commit',
    label: 'その行を確定して閉じる',
    contexts: ['row'],
    // ⚠ `Shift+Tab` を残す(着地前レビュー 9)── 直す前は `ke.key === 'Tab'` で
    //    **修飾を見ていなかった**ので `Shift+Tab` でも確定していた。和音一致に
    //    変えた時点で静かに落ちており、押すと焦点だけがブラウザ既定で飛んでいた
    defaults: ['Tab', 'Shift+Tab', 'Mod+Enter', 'Mod+S'],
  },
  {
    id: 'row-cancel',
    label: 'その行の編集をやめる',
    contexts: ['row'],
    defaults: ['Escape'],
  },
  /**
   * ⚠ **`row-next` / `row-prev`(`Alt+↓` / `Alt+↑`)は 2026-08-28 に外した**(#524)。
   *
   * > user 指示「**インライン編集のカーソル移動の Alt+上下でのテキストボックス移動を
   * > 廃止、代わりにテキストボックス上端または下端の境界では 2 回同じ方向の上下
   * > どちらかのカーソルを押すことで次のテキストボックスに移動するようにする**」
   *
   * 🔑 **動線は減っていない** ── 素の `↑` / `↓` を端で 2 回押せば移る
   * (規則は `features/boundary-step.ts`、配線は `adapter/ui/render/row-swap.ts`)。
   * ⚠ **表からも消す** ── 残すと**同じことをする道が 2 本**になり、
   *   鍵の一覧にも出続ける(CLAUDE.md §7)。
   */
  // ── 1 面(ライブ)の面そのもの
  {
    id: 'edit-all',
    label: '全文を 1 つの欄で編集する',
    contexts: ['live'],
    defaults: ['Mod+A'],
  },
  {
    id: 'undo',
    label: '取り消す',
    contexts: ['live'],
    defaults: ['Mod+Z'],
  },
  {
    id: 'redo',
    label: 'やり直す',
    contexts: ['live'],
    defaults: ['Mod+Shift+Z', 'Mod+Y'],
  },
] as const;

/** id → コマンド。⚠ 引けない id は**存在しない**(呼び手の綴り間違いを黙って通さない)。 */
const BY_ID = new Map(KEY_COMMANDS.map((c) => [c.id, c]));

export function findCommand(id: string): KeyCommand | null {
  return BY_ID.get(id) ?? null;
}

/**
 * 🔴 **`code` から基本キーを採る**(`key` ではなく)。
 *
 * ⚠ `key` は**修飾で化ける**: mac の `Alt+[` は `“`、`Shift+1` は `!`。
 * `Alt+[` を `key` で見ていた実装(直す前の `binder.ts:1728`)は、
 * **mac で 1 度も効かない**近道だった。`code` は物理キーなので化けない。
 * ⚠ 代わりに**配列に依らない保証は無い**(AZERTY の `KeyA` は `Q` の位置)──
 * だから表示は「その配列で押す場所」であって「刻印」ではない、と割り切る。
 * 🔑 `code` が読めない環境(合成 event / 一部の IME)では `key` に落ちる。
 */
const NAMED_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Slash: 'Slash',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Comma: 'Comma',
  Period: 'Period',
  Minus: 'Minus',
  Equal: 'Equal',
  Backquote: 'Backquote',
  /**
   * 🔴 **US 配列に無い物理キー**(着地前レビュー 7)。`code` に賭けた以上、
   * JIS の `IntlYen` / `IntlRo`、ISO の `IntlBackslash` は**名前を持たない** ──
   * 既定の `Ctrl+\\`(左のペイン)が、その配列では**押せない鍵**になる。
   * ⚠ 同じ「バックスラッシュを打つ鍵」へ寄せる ── ISO では 1 つの名前に 2 つの
   * 物理キーが当たるが、「押せない」より良いと判断した。
   */
  IntlYen: 'Backslash',
  IntlRo: 'Backslash',
  IntlBackslash: 'Backslash',
};

/** 表示のときだけ使う「刻印」。⚠ 割当の同一性はあくまで `code` 側の名前で見る。 */
const CODE_GLYPH: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/**
 * 🔴 **刻印 → 物理キーの名前**(`code` が読めないときの橋)。
 *
 * ⚠ これが無いと、`code` を持たない打鍵(合成 event / 一部の IME・仮想キーボード)は
 * `[` のまま残り、`code` 由来の `BracketLeft` と**永久に一致しない** ──
 * 同じキーが 2 つの名前を持つと、割当は片方でしか効かない(実際 test が落ちた)。
 * ⚠ **Shift を押した形も同じ物理キーへ寄せる**(US 配列。`{` は `[` の位置)──
 * `Ctrl+?` のような「Shift 込みで語られる近道」を素直に書けるようにするため。
 */
const GLYPH_TO_CODE: Readonly<Record<string, string>> = {
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '-': 'Minus',
  '_': 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '/': 'Slash',
  '?': 'Slash',
  '`': 'Backquote',
  '~': 'Backquote',
};

/** 修飾キーそのものの打鍵(= 割当にならない)。 */
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Dead']);

/** `KeyboardEvent` から基本キーを採る。修飾キー単独なら `null`。 */
export function baseKeyOf(ev: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  if (MODIFIER_KEYS.has(ev.key)) return null;
  const code = typeof ev.code === 'string' ? ev.code : '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return numpad[1]!;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_CODES[code] !== undefined) return NAMED_CODES[code]!;
  // ⚠ `code` が無い / 知らない ── `key` に落ちる(合成 event の test もここを通る)
  const k = ev.key;
  if (typeof k !== 'string' || k.length === 0) return null;
  if (k === ' ') return 'Space';
  if (GLYPH_TO_CODE[k] !== undefined) return GLYPH_TO_CODE[k]!;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** `KeyboardEvent` → 和音。修飾キー単独なら `null`。 */
export function chordOf(
  ev: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): Chord | null {
  const key = baseKeyOf(ev);
  if (key === null) return null;
  return { mod: ev.ctrlKey || ev.metaKey, alt: ev.altKey, shift: ev.shiftKey, key };
}

/** 和音 → 正規化した文字列(保存と比較はこの形だけ)。 */
export function chordToString(c: Chord): string {
  const parts: string[] = [];
  if (c.mod) parts.push('Mod');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  parts.push(c.key);
  return parts.join('+');
}

/**
 * 文字列 → 和音。読めなければ `null`。
 * ⚠ 大文字小文字は**修飾語だけ**吸収する ── 基本キーは `KeyB` の `B` と
 * `Escape` のように**綴りが意味**なので、勝手に畳まない(`b` は `B` へ寄せる)。
 */
export function chordFromString(s: string): Chord | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const parts = s.split('+').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return null;
  let mod = false;
  let alt = false;
  let shift = false;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i]!.toLowerCase();
    if (p === 'mod' || p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'meta') mod = true;
    else if (p === 'alt' || p === 'option') alt = true;
    else if (p === 'shift') shift = true;
    else return null; // 知らない修飾語 ── 黙って落とさない
  }
  const raw = parts[parts.length - 1]!;
  // ⚠ 書く側も `Alt+[` と書けるようにする(表示の刻印と保存の名前を往復させる)
  const bridged = GLYPH_TO_CODE[raw];
  const key = bridged ?? (raw === ' ' ? 'Space' : raw.length === 1 ? raw.toUpperCase() : raw);
  return { mod, alt, shift, key };
}

/** 同じ割当か。⚠ 文字列の一致ではなく**正規化してから**比べる。 */
export function sameChord(a: string, b: string): boolean {
  const ca = chordFromString(a);
  const cb = chordFromString(b);
  if (ca === null || cb === null) return false;
  return chordToString(ca) === chordToString(cb);
}

/**
 * 画面に出す形。mac は `⌘⌥⇧`、それ以外は `Ctrl+Alt+Shift`。
 * ⚠ **記号を詰めない**(`⌘ N`)── 詰めると読み手が 1 つのキーだと思う。
 */
export function chordLabel(s: string, mac = isMac()): string {
  const c = chordFromString(s);
  if (c === null) return s;
  const parts: string[] = [];
  if (c.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (c.alt) parts.push(mac ? '⌥' : 'Alt');
  if (c.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(CODE_GLYPH[c.key] ?? c.key);
  return parts.join(' + ');
}

/** mac かどうか(表示のためだけ)。⚠ 判定に使わない ── 割当は `Mod` で 1 つ。 */
export function isMac(): boolean {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const p: string = nav?.platform ?? '';
    const ua: string = nav?.userAgent ?? '';
    return /Mac|iPhone|iPad/.test(p) || /Mac OS X/.test(ua);
  } catch {
    return false;
  }
}

/**
 * 🔴 **その和音は「文字を打つ手」とぶつかるか**(着地前レビュー 2)。
 *
 * ⚠ `whileTyping` を**コマンド単位**にしていたので、`F1` のための免除が
 * **同じコマンドの別名 `Alt+5` にもそのまま効いて**いた ── mac では
 * `Option+5` が `∞`、`Option+[` が `“` を打つ鍵なので、**本文を書いている最中に
 * 文字が入らずヘルプが開く / ペインが畳まれる**(実装を読んで判明。mac 実機は未確認)。
 * 🔑 判定は**和音**でやる: `Mod` を含む / F キー / 矢印・編集キーは文字を打たない。
 * それ以外(`Alt+<1 文字>` や素の 1 文字)は、打鍵中は効かせない。
 */
export function typesCharacter(chord: Chord): boolean {
  if (chord.mod) return false; // Ctrl / ⌘ の組み合わせは文字にならない
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(chord.key)) return false;
  // 矢印・移動・編集キーは「文字を打つ鍵」ではない(mac の Option+← は移動 ──
  // ⚠ そこを奪う是非は別の話で、直す前からの挙動をここでは変えない)
  if (NON_TEXT_KEYS.has(chord.key)) return false;
  return true;
}

/** 文字を打たないキー(移動・編集)。⚠ **記号は入れない** ── `Alt+[` は打てる。 */
const NON_TEXT_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Delete',
  'Backspace',
  'Tab',
  'Enter',
]);

/**
 * 🔴 **修飾の無い割当は原則断る** ── 素の `B` を割り当てると、その面で **B が打てなくなる**。
 * 例外は「文字を打つ鍵ではない」もの(F1〜F24 / Escape / Tab)だけ。
 * ⚠ Tab を例外に入れるのは既定(`row-commit`)がそうだから ── 例外を作らないと
 * **自分の既定を自分の検査が落とす**(2026-08-14「成り立たない条件」の型)。
 */
const BARE_ALLOWED = new Set(['Escape', 'Tab']);

/**
 * 🔴 **文字を打たない面**(2026-08-18、整理の面の鍵)。ここでの素の鍵は**安全**である ──
 * 焦点が行(`<tr>`)に在るときは、そもそも字を打つ相手が居ない。
 * ⚠ 逆に `global` は「打っている最中でも飛んでくる」ので、素の鍵を許してはいけない。
 * 🔑 `Enter` / `Delete` / `Backspace` は **OS のファイラの標準**であり、
 * ここを許さないと「平仄を合わせる」(user 裁定 2026-08-18)が実行できない。
 */
const NON_TYPING_CONTEXTS: ReadonlySet<KeyContext> = new Set<KeyContext>(['filer', 'dual']);

function bareAllowed(key: string, commandId?: string): boolean {
  if (BARE_ALLOWED.has(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  const cmd = commandId === undefined ? null : findCommand(commandId);
  return cmd !== null && cmd !== undefined && cmd.contexts.every((c) => NON_TYPING_CONTEXTS.has(c));
}

/**
 * 🔴 **横取りしてはいけない割当**(OS / ブラウザ側の意味が強すぎるもの)。
 * ⚠ `Mod+S` / `Mod+A` / `Mod+Z` は **PKC3 が既に横取りしている**(既定)ので入れない ──
 * 「入れたら既定が違反になる」条件を書かない(§1「成り立たない主張」の予防)。
 */
const REFUSED: readonly string[] = [
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+Q',
  'Mod+W',
  'Mod+T',
  // 🔴 **奪えてしまう鍵**(着地前レビュー 6)── ブラウザが守る `Mod+W` 等と違い、
  //    再読込と印刷は**ページが横取りできる**。奪うと user は戻し道を見失う
  //    (「再読込できないと直せない」と思う)
  'Mod+R',
  'Mod+P',
];

export interface BindingProblem {
  readonly kind: 'unreadable' | 'bare' | 'refused' | 'conflict';
  readonly message: string;
  /** `conflict` のとき、ぶつかった相手。 */
  readonly withCommandId?: string;
}

/**
 * 割当を検める。⚠ **衝突は「文脈が重なるとき」だけ**である ──
 * 行の欄の `Tab` と 2 列の編集の `Tab` は同時に効かないので、ぶつかっていない。
 */
export function validateBinding(
  commandId: string,
  chord: string,
  bindings: KeymapBindings,
): BindingProblem | null {
  const c = chordFromString(chord);
  if (c === null) return { kind: 'unreadable', message: 'このキーは割り当てられません' };
  const norm = chordToString(c);
  if (!c.mod && !c.alt && !bareAllowed(c.key, commandId)) {
    return {
      kind: 'bare',
      message: 'Ctrl(⌘)か Alt と組み合わせてください ── そのままだと文字が打てなくなります',
    };
  }
  if (REFUSED.some((r) => sameChord(r, norm))) {
    return { kind: 'refused', message: 'これはコピー・貼り付けなどに使われる組み合わせです' };
  }
  const me = findCommand(commandId);
  if (me === null) return { kind: 'unreadable', message: '知らないコマンドです' };
  for (const other of KEY_COMMANDS) {
    if (other.id === commandId) continue;
    if (!contextsOverlap(me.contexts, other.contexts)) continue;
    const theirs = bindings[other.id] ?? other.defaults;
    if (theirs.some((t) => sameChord(t, norm))) {
      return {
        kind: 'conflict',
        message: `「${other.label}」と同じ割当です`,
        withCommandId: other.id,
      };
    }
  }
  return null;
}

/**
 * 文脈が重なるか。`global` は document で受けるので**全部と重なる**。
 * ⚠ ここを「重ならない」に倒すと、全域の割当が面の割当を静かに食う組合せを作れてしまう。
 */
export function contextsOverlap(
  a: readonly KeyContext[],
  b: readonly KeyContext[],
): boolean {
  return a.some((x) => x === 'global' || b.some((y) => y === 'global' || x === y));
}

/** コマンド id → 割当(複数可)。⚠ **無い id は既定**、空配列は「割当なし」。 */
export type KeymapBindings = Readonly<Record<string, readonly string[]>>;

/** 既定の割当だけの表。 */
export function defaultBindings(): KeymapBindings {
  const out: Record<string, readonly string[]> = {};
  for (const c of KEY_COMMANDS) out[c.id] = c.defaults;
  return out;
}

/**
 * 上書きを既定へ重ねる。
 * ⚠ **知らない id は捨てる**(古い保存が残っていても壊れない)。
 * ⚠ 読めない割当も捨てる ── 壊れた 1 個で全部の近道が死ぬのがいちばん困る。
 */
export function resolveBindings(overrides: Readonly<Record<string, unknown>>): KeymapBindings {
  const out: Record<string, readonly string[]> = {};
  for (const c of KEY_COMMANDS) {
    const raw = overrides[c.id];
    if (raw === undefined) {
      out[c.id] = c.defaults;
      continue;
    }
    if (!Array.isArray(raw)) {
      out[c.id] = c.defaults;
      continue;
    }
    const list: string[] = [];
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      const parsed = chordFromString(v);
      if (parsed === null) continue;
      const norm = chordToString(parsed);
      if (!list.includes(norm)) list.push(norm);
    }
    // ⚠ **空配列は「割当なし」として尊重する**(既定へ戻さない)──
    //    「この近道は要らない」という意思表示を勝手に取り消さない
    out[c.id] = list;
  }
  return out;
}

/**
 * 打鍵 → コマンド id。⚠ **文脈を必ず渡す**(呼び手の面が自分で名乗る)。
 * @returns 当たったコマンドの id。無ければ `null`。
 */
export function matchCommand(
  chord: Chord | null,
  context: KeyContext,
  bindings: KeymapBindings,
): string | null {
  if (chord === null) return null;
  const s = chordToString(chord);
  for (const c of KEY_COMMANDS) {
    if (!c.contexts.includes(context)) continue;
    const list = bindings[c.id] ?? c.defaults;
    if (list.some((b) => sameChord(b, s))) return c.id;
  }
  return null;
}
