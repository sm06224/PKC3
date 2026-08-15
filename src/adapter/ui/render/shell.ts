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
import { BROWSE_ICONS, iconButton, iconSpan } from './icons';
import { PANES, PANE_LABELS } from '@features/pane-visibility';
import { BROWSE_TABS } from './browse';

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
  { archetype: 'todo', label: 'Todo' },
] as const;

/**
 * **ノート全体**に対する操作 ── だから**左の列**が持つ(P8 段⑤ の規則)。
 * ⚠ 上の帯には置かない(置いたのが「かぶり」の正体だった)。
 */
const COLLECTION_COMMANDS: readonly { action: string; label: string; title: string }[] = [
  {
    action: 'import-file',
    label: '取り込む',
    title: 'PKC2 の書き出し(HTML / ZIP)/ PKC3 のバックアップ(.pkc3.zip)/ Markdown を取り込みます',
  },
  { action: 'export-archive', label: 'バックアップ', title: '元に戻せる形で保存します' },
  { action: 'export-html', label: '閲覧用 HTML', title: '読むだけの 1 枚にまとめます' },
  {
    action: 'export-markdown',
    label: 'Markdown',
    title: 'Markdown ファイルとして保存します',
  },
  {
    action: 'purge-orphan-assets',
    label: '使っていない添付を消す',
    title: 'どのノートからも参照されていない添付を削除します(元に戻せません)',
  },
] as const;

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
  for (const [action, label, title] of [
    ['nav-back', '戻る', '前に見ていたノートへ戻ります(Alt+←)'],
    ['nav-forward', '進む', '戻る前のノートへ進みます(Alt+→)'],
  ] as const) {
    const btn = iconButton(action, label);
    btn.title = title;
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
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sort.append(opt);
  }
  findBar.append(sort);

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
  create.title = 'この種類で新しく作ります(Ctrl+N)';
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

  const attach = iconButton('attach-file', '添付');
  attach.title = 'ファイルを取り込んで添付にします';
  createBar.append(kind, create, pick, attach);

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
  impInput.accept = '.html,.htm,.zip,.md,.markdown,text/html,application/zip,text/markdown';
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
  sidebar.append(tabs, findBar, createBar, menu, browseHost, collectionBar);

  // ── 中央(いま開いているもの)────────────────────────
  // 🔑 本文と**追記欄は別の器**にする(P8 段⑧)。本文は書き換わるたびに作り直すので、
  // 同じ器に入れると**打ちかけの追記が消え、focus も飛ぶ**(追記のたびに起きる)。
  const center = document.createElement('main');
  center.setAttribute('data-pkc-region', 'center');
  /**
   * 🔴 **ペインの開閉は中央に置く**(#197 / 台帳 #180 の D-1)。
   *
   * ⚠ 左の列の中に置くと、**左を畳んだ瞬間に「戻す」ボタンごと消える** ──
   *   戻れない画面を作ってしまう。中央は畳めない(= 常に在る)ので、
   *   操作子の置き場はここしか無い。
   * ⚠ user 指示「同じものが常に同じ場所にある」── 畳んだ状態は保存する
   *   (`adapter/ui/render/pane-visibility.ts`)。
   */
  const paneBar = document.createElement('div');
  paneBar.setAttribute('data-pkc-region', 'pane-bar');
  for (const id of PANES) {
    const btn = iconButton('toggle-pane', PANE_LABELS[id], `toggle-pane:${id}`);
    btn.setAttribute('data-pkc-pane', id);
    btn.setAttribute('aria-pressed', 'true');
    btn.title = `${PANE_LABELS[id]}の列を畳む・戻す`;
    paneBar.append(btn);
  }
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const append = document.createElement('div');
  append.setAttribute('data-pkc-region', 'append');
  append.hidden = true;
  center.append(paneBar, detail, append);

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

  shell.append(sidebar, center, inspector, announce, update, notices, status);
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
