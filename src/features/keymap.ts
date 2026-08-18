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
export type KeyContext = 'global' | 'editor' | 'append' | 'row' | 'live' | 'filer';

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
    contexts: ['filer'],
    defaults: ['Enter'],
    note: 'OS のファイラと同じ ── 行を選んで Enter',
  },
  {
    id: 'filer-parent',
    label: '親フォルダへ',
    contexts: ['filer'],
    defaults: ['Backspace', 'Alt+ArrowUp'],
  },
  {
    id: 'filer-trash',
    label: '選んでいるものをゴミ箱へ',
    contexts: ['filer'],
    defaults: ['Delete'],
    note: 'ゴミ箱からいつでも戻せます',
  },
  {
    id: 'filer-select-all',
    label: 'いま出ている行をぜんぶ選ぶ',
    contexts: ['filer'],
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
    contexts: ['filer'],
    defaults: ['ArrowDown'],
    note: '送った行が選ばれます(開くのは Enter)',
  },
  {
    id: 'filer-row-up',
    label: '前の行へ',
    contexts: ['filer'],
    defaults: ['ArrowUp'],
  },
  {
    id: 'filer-extend-down',
    label: '次の行まで選び足す',
    contexts: ['filer'],
    defaults: ['Shift+ArrowDown'],
    note: '起点は最後に選んだ行',
  },
  {
    id: 'filer-extend-up',
    label: '前の行まで選び足す',
    contexts: ['filer'],
    defaults: ['Shift+ArrowUp'],
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
    id: 'open-settings',
    label: '設定の面へ',
    contexts: ['global'],
    defaults: ['Alt+3', 'Mod+Comma'],
  },
  {
    id: 'open-flags',
    label: 'フラグの面へ',
    contexts: ['global'],
    defaults: ['Alt+4', 'F12'],
    whileTyping: true,
    note: 'PKC2 の F12(Flags Inspector)と同じ手',
  },
  {
    id: 'open-help',
    label: 'ヘルプの面へ',
    contexts: ['global'],
    defaults: ['F1', 'Alt+5', 'Mod+Shift+Slash'],
    whileTyping: true,
    note: 'PKC2 の Ctrl+? と同じ手。F1 は文字を打つ鍵ではないので打鍵中でも効きます',
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
    note: '別の場所を左右に開いて、まとめて移す面です',
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
  {
    id: 'toggle-focus-mode',
    label: '両側のペインを畳む / 戻す(集中)',
    contexts: ['global'],
    defaults: ['Mod+Alt+Backslash'],
    whileTyping: true,
    note: 'PKC2 のフォーカスモードと同じ手',
  },
  {
    id: 'nav-back',
    label: '選択を戻る',
    contexts: ['global'],
    defaults: ['Alt+ArrowLeft'],
    whileTyping: true,
  },
  {
    id: 'nav-forward',
    label: '選択を進む',
    contexts: ['global'],
    defaults: ['Alt+ArrowRight'],
    whileTyping: true,
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
  {
    id: 'format-link',
    label: 'リンク',
    contexts: ['editor', 'row'],
    defaults: ['Mod+K'],
  },
  // ── 継ぎ足しの欄
  {
    id: 'append-send',
    label: '継ぎ足しを送る',
    contexts: ['append'],
    defaults: ['Mod+Enter'],
    note: '継ぎ足しの欄の中だけ',
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
  {
    id: 'row-next',
    label: 'その行を確定して次の行を開く',
    contexts: ['row'],
    defaults: ['Alt+ArrowDown'],
  },
  {
    id: 'row-prev',
    label: 'その行を確定して前の行を開く',
    contexts: ['row'],
    defaults: ['Alt+ArrowUp'],
  },
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
const NON_TYPING_CONTEXTS: ReadonlySet<KeyContext> = new Set<KeyContext>(['filer']);

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
