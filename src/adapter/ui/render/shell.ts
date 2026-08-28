/**
 * app の枠(P8)。初回に 1 度だけ構築する ── 以後どの region も作り直さない。
 * 機能セレクタは data-pkc-* のみ(PKC2 規約)。
 *
 * 🔑 **隠さない**(user 指示 2026-08-03。業務画面の作法)。
 * 以前は `取り込む▾ 書き出す▾ 整理▾ 表示▾` と畳んでいたが、主要な導線を畳むと
 * 「どこにあるか探す」手間が増える。役割ごとに**区切って全部並べる**。
 * ⚠ だから `<details>` のメニューはもう使わない(`menu.ts` も外した)。
 *
 * 🔑 **3 列**(一覧 / 本文 / 付随情報)。編集に入っても列は動かない。
 */
import { SEALED_ARCHETYPES, SEALED_VIEWS } from '@features/sealed';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';
import { COLLECTION_COMMANDS } from './commands';
import { BROWSE_ICONS, iconButton, iconSpan } from './icons';
import { COLUMN_PANES, PANE_LABELS } from '@features/pane-visibility';
import { BROWSE_TABS } from './browse';
import {
  timerBarLabel,
  timerEntryText,
  type TimerRun,
} from '@features/timer/timer-run';
import {
  alarmBarLabel,
  alarmEntryText,
  type AlarmDue,
} from '@features/alarm/alarm-due';

export interface ShellRegions {
  /** 左の列の中身(探し方で切り替わる)。 */
  browseHost: HTMLElement;
  sidebar: HTMLElement;
  /** 中央の列そのもの(本文 + 追記欄)。grid の 1 マスはこちら。 */
  center: HTMLElement;
  detail: HTMLElement;
  /** 追記欄(P8 段⑧)。⚠ **本文とは別の器** ── 本文の再描画で打鍵が消えない。 */
  append: HTMLElement;
  /** 右の付随情報。選んでいるものの素性と、それに対する操作。 */
  inspector: HTMLElement;
  status: HTMLElement;
  /**
   * 取込などの **複数件の注意**を全部見せる面(P6c review H-2)。
   *
   * ⚠ status footer は `textContent` 上書きの 1 行なので、**注意が N 件あっても
   * 1 件目しか user に届かない**。
   */
  notices: HTMLElement;
  /**
   * 「新しい版があります」の面(P7 段⑤)。
   *
   * ⚠ notices とは**別の面**。notices は取込・書出しのたびに中身が作り替わるので、
   * そこへ載せると user が押す前に**次の取込で黙って消える**。
   */
  update: HTMLElement;
  /**
   * 🔴 **起動したときのお知らせ**(P11 段⑤)。
   *
   * ⚠ notices / update とは**別の行**。理由は上の 2 つと同じで、しかも両方効く ──
   * notices は取込のたびに中身が作り替わるので**読む前に消え**、update と同じ行に
   * すると**両方出たときに重なる**。
   */
  announce: HTMLElement;
}

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
   */
  { view: 'settings', label: '設定' },
  // ⚠ 開発者・パワーユーザー向け(P11)。設定とは**別の面**にする(裁定 Q3)
  { view: 'flags', label: 'フラグ' },
  /**
   * ヘルプ(P11。user 指示 2026-08-07「ヘルプ画面にはマニュアル導線も含めて
   * ください」)。⚠ **一番下**に置く ── 「困ったら最後に見る場所」の位置。
   */
  { view: 'help', label: 'ヘルプ' },
] as const;

/**
 * 作れるもの。⚠ 封印中のものは出さない。
 * generic / opaque は PKC2 の 2026-04-26 audit で作成導線が撤去済み ── その判断を継ぐ。
 */
const CREATE_BUTTONS: readonly { archetype: string; label: string }[] = [
  { archetype: 'text', label: 'ノート' },
  { archetype: 'textlog', label: 'ログ' },
  { archetype: 'spreadsheet', label: '表' },
  { archetype: 'folder', label: 'フォルダ' },
  /**
   * 🔴 **条件に合うノートが自動で集まる入れ物**(#421 段①。user 要望 2026-08-26)。
   * ⚠ フォルダの**隣**に置く ── 探すときに 2 か所を見ないで済む。
   */
  { archetype: 'smart', label: 'スマート' },
  // 🔴 **雛形**(#196 / B-2)── 作れないと user は自分の雛形を持てない
  { archetype: 'snippet', label: '雛形' },
  { archetype: 'todo', label: 'Todo' },
] as const;


/**
 * 🔴 **収録中の帯を出す / 畳む**(#413)。
 *
 * ⚠ **器は常設で、`hidden` と字だけ**を触る ── 1 秒ごとに組み直すと、
 *   押している最中の「止める」が指の下から消える。
 * ⚠ 器が無ければ**何もしない** ── `buildShell` より先に呼ばれても落ちない
 *   (器を作る側と描く側は別の file なので、順番はここでは保証できない)。
 */
export function paintCaptureBar(root: HTMLElement, line: string | null): void {
  const bar = root.querySelector<HTMLElement>('[data-pkc-region="capture-bar"]');
  if (bar === null) return;
  bar.hidden = line === null;
  const text = bar.querySelector<HTMLElement>('[data-pkc-field="capture-status"]');
  if (text !== null) text.textContent = line ?? '';
}

/**
 * 🔴 **タイマーの帯を描き直す**(#279)。
 *
 * ⚠ **行は lid で使い回す** ── 1 秒ごとに作り直すと、押している最中の
 *   「止める」が**指の下から消える**(収録の帯が器を常設にしているのと同じ理由。
 *   あちらは 1 行なので `hidden` だけで足りたが、こちらは**本数が変わる**)。
 * ⚠ 器が無ければ**何もしない**(`buildShell` より先に呼ばれても落ちない)。
 */
export function paintTimerBar(
  root: HTMLElement,
  runs: readonly TimerRun[],
  nowMs: number,
): void {
  const bar = root.querySelector<HTMLElement>('[data-pkc-region="timer-bar"]');
  if (bar === null) return;
  bar.hidden = runs.length === 0;
  const label = bar.querySelector<HTMLElement>('[data-pkc-field="timer-label"]');
  if (label !== null) label.textContent = runs.length === 0 ? '' : timerBarLabel(runs.length);
  const list = bar.querySelector<HTMLElement>('[data-pkc-field="timer-list"]');
  if (list === null) return;

  const alive = new Set(runs.map((r) => r.lid));
  for (const li of [...list.children]) {
    if (!alive.has(li.getAttribute('data-pkc-timer') ?? '')) li.remove();
  }
  for (const run of runs) {
    let li = childByAttr(list, 'data-pkc-timer', run.lid);
    if (li === null) {
      li = document.createElement('li');
      li.setAttribute('data-pkc-timer', run.lid);
      const text = document.createElement('span');
      text.setAttribute('data-pkc-field', 'timer-entry');
      const stop = iconButton('stop-timer', '止める');
      stop.setAttribute('data-pkc-timer', run.lid);
      stop.title = '計るのをやめて、そのノートの本文に作業時間を書きます';
      const drop = iconButton('discard-timer', '捨てる');
      drop.setAttribute('data-pkc-timer', run.lid);
      drop.title = '計るのをやめます(本文には書きません)';
      li.append(text, stop, drop);
      list.append(li);
    }
    const text = li.querySelector<HTMLElement>('[data-pkc-field="timer-entry"]');
    if (text !== null) text.textContent = timerEntryText(run, nowMs);
  }
}

/**
 * 🔴 **属性の値で行を引く**(選択子を組み立てない)。
 *
 * ⚠ 1 稿目は `[data-pkc-timer="…"]` という**選択子を文字列で組んで**いた。
 *   lid や鍵は普通は英数字だが、**取込で来た lid は何が入っているか分からない**
 *   ── 引用符が 1 文字混じると `querySelector` が例外を投げ、
 *   **帯ごと描けなくなる**(#280 の test が実際に落として教えた)。
 * ⚠ `CSS.escape` で逃がすのも解ではない ── あれは**識別子**用であって、
 *   引用符の中の文字列用ではない。**選択子を組まなければ、逃がす必要も無い**。
 */
function childByAttr(list: HTMLElement, attr: string, value: string): HTMLElement | null {
  for (const el of list.children) {
    if (el.getAttribute(attr) === value) return el as HTMLElement;
  }
  return null;
}

/**
 * 🔴 **鳴っている予定の帯を描き直す**(#280)。
 *
 * ⚠ **行は鍵で使い回す**(タイマーの帯と同じ理由)── 作り直すと、
 *   押している最中に「開く」が指の下から消える。
 * ⚠ **タイマーと同じ行にしない** ── 3 本計っていると、鳴った知らせが
 *   横へ押し出されて**見えなくなる**(知らせは押し出されてはいけない)。
 */
export function paintAlarmBar(root: HTMLElement, due: readonly AlarmDue[]): void {
  const bar = root.querySelector<HTMLElement>('[data-pkc-region="alarm-bar"]');
  if (bar === null) return;
  bar.hidden = due.length === 0;
  const label = bar.querySelector<HTMLElement>('[data-pkc-field="alarm-label"]');
  if (label !== null) label.textContent = due.length === 0 ? '' : alarmBarLabel(due.length);
  const list = bar.querySelector<HTMLElement>('[data-pkc-field="alarm-list"]');
  if (list === null) return;

  const alive = new Set(due.map((d) => d.key));
  for (const li of [...list.children]) {
    if (!alive.has(li.getAttribute('data-pkc-alarm') ?? '')) li.remove();
  }
  for (const d of due) {
    let li = childByAttr(list, 'data-pkc-alarm', d.key);
    if (li === null) {
      li = document.createElement('li');
      li.setAttribute('data-pkc-alarm', d.key);
      const text = document.createElement('span');
      text.setAttribute('data-pkc-field', 'alarm-entry');
      const open = iconButton('open-alarm', '開く');
      open.setAttribute('data-pkc-alarm', d.key);
      open.setAttribute('data-pkc-entry', d.lid);
      open.title = 'その予定を書いたノートを開きます';
      const close = iconButton('dismiss-alarm', '閉じる');
      close.setAttribute('data-pkc-alarm', d.key);
      close.title = 'この知らせを片付けます(本文は変わりません)';
      li.append(text, open, close);
      list.append(li);
    }
    const text = li.querySelector<HTMLElement>('[data-pkc-field="alarm-entry"]');
    if (text !== null) text.textContent = alarmEntryText(d);
  }
}

export function buildShell(root: HTMLElement): ShellRegions {
  root.textContent = '';
  const shell = document.createElement('div');
  shell.setAttribute('data-pkc-region', 'shell');

  // ── サイドバー(一覧)────────────────────────────
  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  /**
   * 🔑 **探し方のタブ**(P8 段⑤)。フォルダもアプリも「探し方」なので、
   * 中央のビューではなくここに置く ── 中央は常に「開いているノート」。
   */
  const tabs = document.createElement('div');
  tabs.setAttribute('data-pkc-region', 'browse-tabs');
  for (const { mode, label } of BROWSE_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'set-browse');
    btn.setAttribute('data-pkc-browse', mode);
    // ⚠ 図案は `icons.ts` から取る(手組みの絵文字表を持たない ── P9 段③)
    const ic = iconSpan(BROWSE_ICONS[mode] ?? 'dot');
    const tx = document.createElement('span');
    tx.setAttribute('data-pkc-field', 'label');
    tx.textContent = label;
    btn.append(ic, tx);
    tabs.append(btn);
  }

  // 🔑 **探す**が先、**作る**が後(増えたときに要るのは探すほう)。
  // ⚠ 1 行に詰めると絞り込み欄が潰れて「絞り」しか読めなくなる ── 段を分ける
  const findBar = document.createElement('div');
  findBar.setAttribute('data-pkc-region', 'find-bar');
  const createBar = document.createElement('div');
  createBar.setAttribute('data-pkc-region', 'create-bar');

  /**
   * 🔴 **選択の戻る・進む**(#190 / 台帳 #180 の B-4)。
   *
   * ⚠ user 指示「**マウスだけで完結し、キーボードは近道**」── 近道だけ足すと
   * **画面のどこにも無い機能**になるので、ボタンを先に置く(近道は `binder` の
   * `Alt+←` / `Alt+→`)。
   * ⚠ 置き場は**探す欄の左**(ブラウザと同じ並び ── 戻る・進む → 探す)。
   * ⚠ 押せないときは `disabled` にする ── 押しても何も起きない dead click を作らない。
   */
  /**
   * 🔴 **1 文字にする**(user 指示 2026-08-15「戻る進むアイコンがデカすぎる。
   * `<`, `>` 一文字でいい みたいなのばっかり」)。⚠ **読み上げは残す** ──
   * 見た目を削るのと、名前を消すのは別である(`aria-label` と `title` を持たせる)。
   */
  /**
    * ⚠ **鍵の綴りを直書きしない**(2026-08-19)── mac では既定のままでも
    * `Alt` ではなく `⌥` であり、user が割当を変えれば説明だけが嘘になる。
    * 説明の**土台**と**命令 id** だけ持たせ、`applyShortcutHints` が組み立てる。
    */
  for (const [action, glyph, label, title, cmd] of [
    ['nav-back', '‹', '戻る', '前に見ていたノートへ戻ります', 'nav-back'],
    ['nav-forward', '›', '進む', '戻る前のノートへ進みます', 'nav-forward'],
  ] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', action);
    btn.setAttribute('data-pkc-glyph', '');
    btn.setAttribute('aria-label', label);
    btn.setAttribute(HINT_BASE, title);
    btn.setAttribute(HINT_COMMAND, cmd);
    btn.title = hintTitle(title, cmd);
    btn.textContent = glyph;
    btn.disabled = true; // 履歴が無い間は押せない(renderer が起こす)
    findBar.append(btn);
  }

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.setAttribute('data-pkc-field', 'entry-filter');
  filter.placeholder = '探す';
  /**
   * 🔴 **文言を実態に合わせる**(#181)。全文検索が入るまでは題名だけだったので
   * 「題名で絞り込みます」と書いてあった ── いまは**本文も探す**ので、そのままだと
   * 「本文は探せない」という嘘を user に見せ続ける(§1 の「文言と実装の食い違い」)。
   */
  filter.title = '題名と本文から探します(Esc で消えます)';
  // ⚠ `placeholder` は名前ではない ── 値を入れると読み上げから消える
  filter.setAttribute('aria-label', '題名と本文から探す');
  findBar.append(filter);

  /**
   * 🔴 **並び順**(#183 / 台帳 #180 の A-3)。⚠ **手で並べ替える導線は既にある**
   * (`move-order-up/down`)── ここで足すのは「一覧全体をどう並べるか」であって、
   * 手動の順序を置き換えるものではない。既定は手動の順(`entry_order`)。
   * ⚠ 場所は**探す欄の隣**(同じ「一覧の見え方」の操作なので離さない)。
   */
  const sort = document.createElement('select');
  sort.setAttribute('data-pkc-field', 'entry-sort');
  sort.setAttribute('data-pkc-action', 'set-entry-sort');
  sort.setAttribute('aria-label', '一覧の並び順');
  sort.title = '一覧の並び順を変えます';
  for (const [value, label] of [
    ['manual', '手動の順'],
    ['updated', '更新が新しい順'],
    ['title', '題名順'],
    ['archetype', '種類順'],
    // ⚠ 2 ペインの「大きさ」の列と**同じ 1 本**(§7)── 面ごとに別の並びを作らない
    ['size', '大きさ順'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sort.append(opt);
  }
  findBar.append(sort);

  /**
   * 🔴 **種類で絞る札**(#411 / 台帳 #180)。中身は state から描く
   * (`SidebarPresenter`)── ここは**器だけ**置く。
   *
   * ⚠ **探す欄の下**に置く(同じ「一覧の絞り方」なので離さない)。⚠ そして
   *   **タブの外**に置く ── 中に入れると、面を変えたときに札が消えて
   *   「絞りが解けた」ように見える(実際は効いたままなので、いちばん混乱する形)。
   */
  const kindBar = document.createElement('div');
  kindBar.setAttribute('data-pkc-region', 'kind-bar');
  // ⚠ 何も出ていないときは畳む(空の帯が 1 行ぶん場所を取らないように)
  kindBar.hidden = true;

  /**
   * 🔴 **分割ボタンにする**(P10、user 指示 2026-08-05
   * 「プルダウン式の新規作成ボタンは使いにくいからマルチメニューに畳んでください。
   *  ▼ を押下した際に種別を選択して、追加ボタンと ctrl+n の対象を更新、
   *  +〇〇みたいにボタンを変更すればいい、これもアイコン欲しいよね」)。
   *
   * 形: **`+ ノート`(本体)+ `▼`(種類を選ぶ)**。選ぶと本体の文言と図案が
   * その種類に変わり、`Ctrl+N` の対象も一緒に変わる。
   *
   * ⚠ `<select>` は**残す**(`hidden`)── いま作る種類の**保持場所**であり、
   * `binder` も test helper もここを読む(1 か所に寄せる)。見せないだけ。
   * ⚠ **`<details>` は使わない** ── この repo は「主要な導線を畳まない」を規律に
   * 持ち、shell に `<details>` が 0 件であることを test で pin している。
   * ボタン + `hidden` の一覧で組めば、その規律を破らずに user の要望を満たせる。
   * ⚠ 封印中の種類は**一覧にも `<select>` にも出さない**(前と同じ)。
   */
  const kind = document.createElement('select');
  kind.setAttribute('data-pkc-field', 'create-kind');
  kind.setAttribute('aria-label', '作るものの種類');
  // ⚠ 見せない ── 種類は分割ボタンで選ぶ。ここは「いま何を作るか」の置き場
  kind.hidden = true;
  const kinds = CREATE_BUTTONS.filter(({ archetype }) => !SEALED_ARCHETYPES.includes(archetype));
  for (const { archetype, label } of kinds) {
    const opt = document.createElement('option');
    opt.value = archetype;
    opt.textContent = label;
    kind.append(opt);
  }

  const first = kinds[0];
  const create = iconButton(
    'create-entry',
    first ? `+ ${first.label}` : '新規',
    // ⚠ 図案は**種類のもの**を出す(user「これもアイコン欲しいよね」)
    first ? `archetype:${first.archetype}` : 'create-entry',
  );
  create.setAttribute('data-pkc-field', 'create-run');
  create.setAttribute(HINT_BASE, 'この種類で新しく作ります');
  create.setAttribute(HINT_COMMAND, 'create-entry');
  create.title = hintTitle('この種類で新しく作ります', 'create-entry');
  // ⚠ 種類は**ボタン自身**にも持たせる ── binder はこちらを先に見るので、
  //    `<select>` を読めない状況でも取り違えない
  if (first) create.setAttribute('data-pkc-archetype', first.archetype);

  /**
   * ▼(種類を選ぶ)。
   * ⚠ **文字は入れない** ── 図案が山形そのものなので、`▼` の文字を足すと
   * **同じものが 2 つ**並ぶ(実機で二重に見えた)。
   * ⚠ この repo は「図案だけのボタンを作らない」を規律に持つが、ここは
   * **分割ボタンの片翼**で、意味は隣の本体(`+ ノート`)が持っている ──
   * 読み上げには `aria-label` で名前を渡す。
   */
  const pick = iconButton('toggle-create-menu', '', 'create-menu');
  pick.setAttribute('data-pkc-field', 'create-pick');
  pick.title = '作る種類を選びます';
  pick.setAttribute('aria-label', '作る種類を選ぶ');
  pick.setAttribute('aria-expanded', 'false');

  // 種類の一覧。⚠ 既定は畳む(選ぶまで場所を取らない)
  const menu = document.createElement('div');
  menu.setAttribute('data-pkc-region', 'create-menu');
  menu.hidden = true;
  for (const { archetype, label } of kinds) {
    const item = iconButton('pick-create-kind', label, `archetype:${archetype}`);
    item.setAttribute('data-pkc-archetype', archetype);
    menu.append(item);
  }

  /**
   * 🔴 **今日のノートを開く**(#348、user 裁定 2026-08-23)。
   *
   * ⚠ **「+ ノート」の隣**に置く ── 押す動機が同じ(いま何か書きたい)なので、
   *   探す場所も同じであるべき。⚠ 別の面(予定など)へ隠すと、
   *   「書きたい」から「予定を開く」への回り道になる。
   * 🔑 文言は**起きること**で書く(user 指示 2026-08-21)── 「日記」ではなく
   *   「今日」。開くと**今日の日付のノート**が出る(無ければ作る)。
   */
  const today = iconButton('open-today', '今日', 'calendar');
  today.setAttribute('data-pkc-field', 'open-today');
  today.title = '今日の日付のノートを開きます(無ければ作ります)';

  const attach = iconButton('attach-file', '添付');
  attach.title = 'ファイルを取り込んで添付にします';
  /**
   * 🔴 **録音・画面収録**(#413。user 要望 2026-07-16
   * 「録音と画面収録を…これで、会議メモをうまく残せるはず」)。
   *
   * ⚠ **「添付」の隣に置く** ── 押す動機が同じ(いま何かを残したい)なので、
   *   探す場所も同じであるべき。
   * 🔴 **画面に出す**(鍵だけにしない)── PKC2 は**コマンドパレットだけ**に
   *   置いており、PKC3 にはそれが無い。⚠ 「画面のどこにも出ていない」は
   *   「届いていない」である(#180 の教訓 3)。
   */
  const rec = iconButton('start-audio-capture', '録音');
  rec.setAttribute('data-pkc-field', 'start-audio-capture');
  rec.title = 'マイクで録って、いま開いているノートに入れます';
  const screen = iconButton('start-screen-capture', '画面');
  screen.setAttribute('data-pkc-field', 'start-screen-capture');
  screen.title = '画面を録って、いま開いているノートに入れます';
  /**
   * 🔴 **タイマー**(#279。user 指示 2026-08-19「…タイマー…は組み込みアプリで
   * リリースしたい」)。
   *
   * ⚠ **録音の隣に置く** ── 押す動機が同じ(いまやっていることを残したい)。
   * ⚠ **中央の面(アプリの一覧)にしない** ── 見るために本文を退かすことになる
   *   (#300 / #292 段⑤ の見分け方「閉じたとき user が失うものは何か」)。
   */
  const timer = iconButton('start-timer', '計る');
  timer.setAttribute('data-pkc-field', 'start-timer');
  timer.title = 'いま開いているノートの作業時間を計ります(止めると本文に入ります)';
  createBar.append(kind, create, pick, today, attach, rec, screen, timer);

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachInput.setAttribute('data-pkc-field', 'attach-input');
  createBar.append(attachInput);

  /** ノート全体に対する操作(取り込む / 書き出す / 片づける)。 */
  const collectionBar = document.createElement('div');
  collectionBar.setAttribute('data-pkc-region', 'collection-bar');
  for (const { action, label, title } of COLLECTION_COMMANDS) {
    const btn = iconButton(action, label);
    btn.title = title;
    collectionBar.append(btn);
  }
  /**
   * 🔴 **操作を名前で探す**(#425 段①)。
   *
   * ⚠ **ボタンを先に置く**(不可侵指示「マウスだけで完結し、キーボードは近道」)──
   *   鍵(`Ctrl/⌘+Shift+P`)だけにすると**画面のどこにも無い機能**になる
   *   (`nav-back` / `nav-forward` を足したときと同じ理由。上の記録)。
   * ⚠ 置き場は**設定・フラグ・ヘルプの隣** ── どれも「アプリ全体の操作」であり、
   *   `COLLECTION_COMMANDS`(取り込む / バックアップ = **書き出しと片づけ**)とは
   *   役割が違う。⚠ あちらの表に混ぜると、
   *   `tests/adapter/collection-commands.test.ts` が守っている
   *   「書き出しと片づけの全数」の意味が濁る。
   * ⚠ 鍵の綴りは `applyShortcutHints` が組み立てる(直書きしない ── mac では
   *   `⌘`、user が割当を変えれば説明だけが嘘になる)。
   */
  {
    const btn = iconButton('open-palette', '操作を探す');
    btn.setAttribute(HINT_BASE, 'できる操作を名前で絞り込んで、その場で実行します');
    btn.setAttribute(HINT_COMMAND, 'open-palette');
    btn.title = hintTitle('できる操作を名前で絞り込んで、その場で実行します', 'open-palette');
    collectionBar.append(btn);
  }
  // 🔑 **設定はここ**(P10)。上の帯を撤去したので、アプリ全体の操作が並ぶ
  // この場所へ移した。⚠ 一覧の操作と**区切って**置く(役割が違う)
  for (const { view, label } of VIEW_BUTTONS) {
    if (SEALED_VIEWS.includes(view)) continue;
    const btn = iconButton('set-view', label, `set-view:${view}`);
    btn.setAttribute('data-pkc-view', view);
    btn.setAttribute('data-pkc-field', 'app-settings');
    collectionBar.append(btn);
  }

  // ⚠ file picker は常設 hidden input(user-gesture 要件と smoke の setInputFiles の
  // 両方に効く)。⚠ **押すボタンと同じ場所**に置く
  const impInput = document.createElement('input');
  impInput.type = 'file';
  // 判別は中身(magic)でやるので accept は誤選択を減らす補助。
  // ⚠ ここに .zip が無いと、**受理器が動いてもファイルを選べない**
  impInput.accept =
    '.html,.htm,.zip,.md,.markdown,.vcf,.vcard,text/html,application/zip,text/markdown,text/vcard';
  impInput.multiple = true;
  impInput.hidden = true;
  impInput.setAttribute('data-pkc-field', 'import-input');
  collectionBar.append(impInput);

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  const browseHost = document.createElement('div');
  browseHost.setAttribute('data-pkc-region', 'browse-host');
  browseHost.append(list);
  // ⚠ 一覧は createBar の**外**(下)── 中に入れると 1 行に混ざって折り返す
  sidebar.append(tabs, findBar, kindBar, createBar, menu, browseHost, collectionBar);

  // ── 中央(いま開いているもの)────────────────────────
  // 🔑 本文と**追記欄は別の器**にする(P8 段⑧)。本文は書き換わるたびに作り直すので、
  // 同じ器に入れると**打ちかけの追記が消え、focus も飛ぶ**(追記のたびに起きる)。
  const center = document.createElement('main');
  center.setAttribute('data-pkc-region', 'center');
  /**
   * 🔴 **ペインの開閉は「列の境目」に置く**(#197 → 2026-08-15 に置き場を変更)。
   *
   * user 指示 2026-08-15: 「**サイドのペインを隠すボタンももっと他の選択肢があると
   * 思う。貴重なセンターペインの上を潰しすぎ**」── 中央の上に帯を 1 本置く形は、
   * **本文の面を毎回 34px 削る**。境目の 12px なら**縦の隙間**を使うので本文は削れない。
   *
   * ⚠ それでも #197 の制約は守る ── **畳んでも操作子が消えてはいけない**。
   *   境目は shell の列なので、隣の面を畳んでも**残る**(面の中に置くと消える)。
   * ⚠ user 指示「同じものが常に同じ場所にある」── 畳んだ状態は保存する。
   */
  const grips: Record<string, HTMLElement> = {};
  for (const id of COLUMN_PANES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-region', 'pane-grip');
    btn.setAttribute('data-pkc-action', 'toggle-pane');
    btn.setAttribute('data-pkc-pane', id);
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', `${PANE_LABELS[id]}の列`);
    // 🔴 **帯は 2 つの仕事をする**(#497)── 押すと畳み、掴むと幅が変わる。
    //    ⚠ 掴めることを字にも書く ── `cursor` だけだと、触りの端末には何も出ない。
    btn.title = `${PANE_LABELS[id]}の列を畳む・戻す(掴むと幅、矢印キーでも動く)`;
    grips[id] = btn;
  }
  /**
   * 🔴 **本文の置換**(#191 / 台帳 #180 の B-3)。ログが伸びたときに要る。
   *
   * ⚠ **器は 1 度しか組まない場所に置く**(この帯)── 編集中の面は打鍵のたびに
   *   描き直すので、そちらに入れると**打ちかけの検索語が消える**
   *   (追記欄を別の器にしたのと同じ理由。P8 段⑧)。
   * ⚠ 既定は畳んでおく ── 常時 2 つの欄が居座るのは「業務画面」ではない。
   */
  const replaceBar = document.createElement('div');
  replaceBar.setAttribute('data-pkc-region', 'replace-bar');
  replaceBar.hidden = true;
  for (const [field, label] of [
    ['replace-find', '探す語'],
    ['replace-with', '置き換える語'],
  ] as const) {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pkc-field', field);
    input.setAttribute('aria-label', label);
    input.placeholder = label;
    replaceBar.append(input);
  }
  /**
   * 🔴 **大文字と小文字を区別する**(#397 ①)。
   *
   * ⚠ 純関数(`body-replace.ts`)も action の型も reducer も**最初から対応していた**
   *   のに、**画面から渡す口だけが無かった** ── `caseSensitive?` が optional
   *   だったので、渡し忘れても tsc が黙る(CLAUDE.md「待ちの口は optional に
   *   しない ── 配線を落としても tsc が黙る」の同型)。
   * ⚠ 既定は**区別しない**(いままでの挙動)── 既定を変えると、
   *   これまで当たっていた語が黙って当たらなくなる。
   */
  const caseLabel = document.createElement('label');
  caseLabel.setAttribute('data-pkc-field', 'replace-case-label');
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.setAttribute('data-pkc-field', 'replace-case');
  caseBox.title = 'これを入れると、大文字と小文字が違う語は置き換えません';
  caseLabel.append(caseBox, document.createTextNode('大小を区別'));
  replaceBar.append(caseLabel);
  const runReplace = iconButton('replace-all', '全部置換');
  runReplace.title = '編集中の本文で、探す語を全部置き換えます';
  replaceBar.append(runReplace);
  /**
   * 🔴 **置換の切替は「編集の帯」へ**(2026-08-15、user 指示「ボタンがボタンすぎる /
   * 中央の上を潰しすぎ」)。⚠ 置換が効くのは**編集中の本文**なので、閲覧中に
   * 出しておくのは「押しても効かない導線」である ── 編集の帯(`format-bar`)へ移した。
   * ⚠ **打ちかけの語を守る器はここのまま**(`replace-bar` は shell 側の兄弟)──
   *   編集の面は打鍵のたびに描き直すので、欄をそちらへ入れると消える。
   * ⚠ 近道(Ctrl+H)も**編集中だけ**効く ── 押すのは同じボタンで、閲覧中は
   *   そのボタンが画面に無いからである(`binder` は「無ければ何もしない」)。
   *   同じ操作が 2 通りの経路を持たないほうが正しい。
   */
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  /**
   * ⚠ **焦点を受けられるようにする**(user 裁定 2026-08-18 の平仄)── フォルダの表で
   * `Enter` を押したときの行き先(OS の「開く」に当たる)。`-1` なので Tab の巡回には
   * 入らない ── 入れると、本文へ辿り着くまでの Tab が 1 つ増える。
   */
  detail.tabIndex = -1;
  const append = document.createElement('div');
  append.setAttribute('data-pkc-region', 'append');
  append.hidden = true;
  /**
   * 🔴 **追記欄の掴む帯**(#497)。user 指示 2026-08-27:「**追記メインで使う場合は
   * わくを大きくしたいとか、閲覧メインで使う時は消したい**」。
   *
   * ⚠ **本文と追記欄の境目に置く** ── 追記欄の中に置くと、畳んだ瞬間に
   *   帯ごと消えて**戻す口が無くなる**(2026-08-23「片道の操作を作らない」)。
   * ⚠ 左右の帯と**同じ部品**(`pane-grip`)にする ── 別々に作ると、掴む所の
   *   見た目も鍵の効き方も 3 か所でばらける(CLAUDE.md §7)。違うのは向きだけ。
   */
  const appendGrip = document.createElement('button');
  appendGrip.type = 'button';
  appendGrip.setAttribute('data-pkc-region', 'pane-grip');
  appendGrip.setAttribute('data-pkc-axis', 'y');
  appendGrip.setAttribute('data-pkc-action', 'toggle-pane');
  appendGrip.setAttribute('data-pkc-pane', 'append');
  appendGrip.setAttribute('aria-pressed', 'true');
  appendGrip.setAttribute('aria-label', `${PANE_LABELS.append}`);
  appendGrip.title = `${PANE_LABELS.append}を畳む・戻す(掴むと高さ、矢印キーでも動く)`;
  center.append(replaceBar, detail, appendGrip, append);

  // ── 右(付随情報)────────────────────────────────
  const inspector = document.createElement('aside');
  inspector.setAttribute('data-pkc-region', 'inspector');

  /**
   * 🔴 **何か言うことがあるときだけ出る帯**(P10)。以前は常設で、99% の時間
   * 「pkc3 v3.0.0」を出していた ── それが「大して働いていない」の中身である。
   * ⚠ 消してはいない ── **エラーの唯一の出口**であり、保存先が意図と違うときの
   * 警告もここに出る(48 か所の `OP_FAILED` が state 経由でここへ来る)。
   * 既定は `hidden` = 場所を取らない(notices / update と同じ作法)。
   */
  const status = document.createElement('footer');
  status.setAttribute('data-pkc-region', 'status');
  status.hidden = true;

  /**
   * 🔴 **収録中の帯**(#413)── 経過 + 概算の大きさ + 止める / 捨てる。
   *
   * ⚠ **shell の行に置く**(サイドバーの中ではない)── 押す口は「添付」の隣に
   *   在るが、**止める口はサイドバーを畳んでも消えてはいけない**。畳んだ瞬間に
   *   止められなくなると、マイクが回り続ける(user 指示 2026-08-22
   *   「その場その場で user が動線をどう捉えるか」)。
   * ⚠ **常設で置いて、収録中だけ出す**(`hidden` の付け外し)── 器を作り直すと、
   *   1 秒ごとの更新で押している最中の「止める」が指の下から消える。
   * ⚠ 捨てる口を**必ず対で**置く(user 指示 2026-08-23「片道の操作を作らない」)。
   */
  const capture = document.createElement('section');
  capture.setAttribute('data-pkc-region', 'capture-bar');
  capture.hidden = true;
  const captureText = document.createElement('span');
  captureText.setAttribute('data-pkc-field', 'capture-status');
  const stopBtn = iconButton('stop-capture', '止める');
  stopBtn.setAttribute('data-pkc-field', 'stop-capture');
  stopBtn.title = '収録を止めて、いま開いているノートに入れます';
  const dropBtn = iconButton('discard-capture', '捨てる');
  dropBtn.setAttribute('data-pkc-field', 'discard-capture');
  dropBtn.title = '収録を捨てます(残しません)';
  capture.append(captureText, stopBtn, dropBtn);

  /**
   * 🔴 **タイマーの帯**(#279)。⚠ 収録の帯(上)と**同じ場所・同じ形**にする。
   * ⚠ **常設で置いて、走っている間だけ出す** ── 行そのものを作り直すと、
   *   1 秒ごとの更新で押している最中の「止める」が指の下から消える。
   * ⚠ 「捨てる」を**必ず対で**置く(user 指示 2026-08-23「片道の操作を作らない」)。
   */
  const timers = document.createElement('section');
  timers.setAttribute('data-pkc-region', 'timer-bar');
  timers.hidden = true;
  const timerLabel = document.createElement('span');
  timerLabel.setAttribute('data-pkc-field', 'timer-label');
  const timerList = document.createElement('ul');
  timerList.setAttribute('data-pkc-field', 'timer-list');
  timers.append(timerLabel, timerList);

  /**
   * 🔴 **鳴っている予定の帯**(#280)。⚠ タイマーの帯の**すぐ下**に置く ──
   *   どちらも「いま起きていること」なので、探す場所を分けない。
   * ⚠ 「開く」と「閉じる」を**対で**置く(片道の操作を作らない)。
   */
  const alarms = document.createElement('section');
  alarms.setAttribute('data-pkc-region', 'alarm-bar');
  alarms.hidden = true;
  const alarmLabel = document.createElement('span');
  alarmLabel.setAttribute('data-pkc-field', 'alarm-label');
  const alarmList = document.createElement('ul');
  alarmList.setAttribute('data-pkc-field', 'alarm-list');
  alarms.append(alarmLabel, alarmList);

  // 既定は空(= 何も出さない)。注意が出たときだけ中身が入る
  const notices = document.createElement('section');
  notices.setAttribute('data-pkc-region', 'notices');
  notices.hidden = true;

  // 既定は空(= 新しい版に気づくまで何も出さない)
  const update = document.createElement('section');
  update.setAttribute('data-pkc-region', 'update');
  update.hidden = true;

  // 既定は空(= 未読が無ければ行の高さは 0)
  const announce = document.createElement('section');
  announce.setAttribute('data-pkc-region', 'announce');
  announce.hidden = true;

  /**
   * ⚠ **並びは画面の左から右**(grid の area 名と揃える)── 掴む帯は
   * 面と面の**あいだ**に置く。畳んでも残るのはここが shell の列だからである。
   */
  shell.append(
    sidebar,
    grips.sidebar!,
    center,
    grips.inspector!,
    inspector,
    capture,
    timers,
    alarms,
    announce,
    update,
    notices,
    status,
  );
  root.append(shell);
  return {
    browseHost,
    sidebar,
    center,
    detail,
    append,
    inspector,
    status,
    notices,
    update,
    announce,
  };
}
