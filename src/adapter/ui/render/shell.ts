/**
 * app の枠(P3 設計メモ §2)。初回に 1 度だけ構築する ── 以後どの region も
 * この枠を作り直さない。機能セレクタは data-pkc-* のみ(PKC2 規約)。
 */
import { installMenuDismiss } from './menu';

export interface ShellRegions {
  topbar: HTMLElement;
  sidebar: HTMLElement;
  detail: HTMLElement;
  status: HTMLElement;
  /**
   * 取込などの **複数件の注意**を全部見せる面(P6c review H-2)。
   *
   * ⚠ status footer は `textContent` 上書きの 1 行なので、**注意が N 件あっても
   * 1 件目しか user に届かない**。段④ で warning に「どのファイルか」を冠したのは、
   * 件数が内側 bundle 数に比例するから ── 出口が 1 行のままでは設計が空振りする。
   */
  notices: HTMLElement;
  /**
   * 「新しい版があります」の面(P7 段⑤)。
   *
   * ⚠ notices とは**別の面**。notices は取込・書出しのたびに中身が作り替わるので、
   * そこへ載せると user が押す前に**次の取込で黙って消える**。
   */
  update: HTMLElement;
}

const VIEW_BUTTONS: readonly { view: string; label: string }[] = [
  { view: 'detail', label: '詳細' },
  { view: 'kanban', label: 'かんばん' },
  { view: 'calendar', label: 'カレンダー' },
  { view: 'filer', label: 'ファイラ' },
  { view: 'launcher', label: 'ランチャー' },
] as const;

/**
 * 作成できる archetype(P3-7a)。attachment は file picker 経路(P4 assets)、
 * form / generic / opaque は PKC2 の 2026-04-26 audit で作成導線が撤去済み
 * (import 済データの表示・編集は可能)── その判断を引き継ぐ。
 */
const CREATE_BUTTONS: readonly { archetype: string; label: string }[] = [
  { archetype: 'text', label: '+ノート' },
  { archetype: 'todo', label: '+Todo' },
  { archetype: 'textlog', label: '+ログ' },
  { archetype: 'spreadsheet', label: '+シート' },
  { archetype: 'folder', label: '+フォルダ' },
] as const;

export function buildShell(root: HTMLElement): ShellRegions {
  root.textContent = '';
  const shell = document.createElement('div');
  shell.setAttribute('data-pkc-region', 'shell');

  const topbar = document.createElement('header');
  topbar.setAttribute('data-pkc-region', 'topbar');
  for (const { view, label } of VIEW_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'set-view');
    btn.setAttribute('data-pkc-view', view);
    btn.textContent = label;
    topbar.append(btn);
  }
  /**
   * 🔑 **役割ごとのサブメニュー**(user 指示 2026-08-03「メニューは役割ごとに
   * サブメニュー化してください」)。以前は 9 個のボタンがベタ並びで、
   * 「見る」「入れる」「出す」「整える」が同じ重さに見えていた。
   *
   * ⚠ **ビューは畳まない** ── 表示の切替は常時使う主軸で、押すたびに開くのは邪魔。
   * 畳むのは「たまに使う・押すと何かが起きる」ものだけである。
   *
   * ⚠ 実体は `<details>` + `<summary>`(素の HTML)。JS で開閉状態を持たない。
   * 開閉の**閉じ方**(外側クリック / Escape / 項目を押したら閉じる)と**排他**は
   * `installMenuDismiss` が一手に担う。
   * ⚠ かつて `name` 属性(ブラウザ native の排他)も付けていたが、**dismiss 側と
   * 重複していて外しても振る舞いが変わらなかった**(変異試験で生存)── 消した。
   * ⚠ **項目の文言は変えない** ── `tests/docs-parity.test.ts` がマニュアルと
   * 突合しているので、畳んでも user が読む語は同じである。
   */
  const menu = (label: string): HTMLElement => {
    const box = document.createElement('details');
    box.setAttribute('data-pkc-menu', label);
    const head = document.createElement('summary');
    head.setAttribute('data-pkc-field', 'menu-label');
    head.textContent = label;
    const items = document.createElement('div');
    items.setAttribute('data-pkc-menu-items', '');
    box.append(head, items);
    topbar.append(box);
    return items;
  };
  const item = (into: HTMLElement, action: string, label: string, title?: string): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', action);
    btn.textContent = label;
    if (title) btn.title = title;
    into.append(btn);
  };

  // 📥 入れる(P6b: PKC2 の書出し / P7 段②: 素の Markdown)
  item(
    menu('取り込む'),
    'import-file',
    '取込',
    'PKC2 の書出し(HTML / ZIP)と素の Markdown を取り込みます',
  );
  // 📤 出す ── バックアップだけが可逆。並び順で「正本」を先頭に置く
  const outMenu = menu('書き出す');
  item(outMenu, 'export-archive', 'バックアップ');
  item(outMenu, 'export-html', '閲覧用 HTML');
  item(outMenu, 'export-markdown', 'Markdown');
  // 🧹 整える ── **明示 purge のみ**(自動 GC はしない)。⚠ 不可逆なので、
  // メニューの内側に置いて「押すまでに一手」を挟む
  item(menu('整理'), 'purge-orphan-assets', '添付の整理');
  // 🎨 見た目(user 指示 2026-08-03「最初はライトとダークのみに」)。
  // ⚠ 文言は**切り替え先**を書く(「ライト」= 押すとライトになる)── 現在地は
  // 画面そのものが示しているので、ここに現在地を書くと二重で分かりにくい
  const viewMenu = menu('表示');
  item(viewMenu, 'set-theme', 'ライト', '配色をライトにします');
  viewMenu.lastElementChild?.setAttribute('data-pkc-theme-value', 'light');
  item(viewMenu, 'set-theme', 'ダーク', '配色をダークにします');
  viewMenu.lastElementChild?.setAttribute('data-pkc-theme-value', 'dark');
  // ⚠ file picker は常設 hidden input(添付と同じ流儀 ── user-gesture 要件と
  // smoke の setInputFiles の両方に効く)。**メニューの外**に置く ── メニューを
  // 閉じると中の input は描画木から外れ、smoke の setInputFiles が届かない
  const impInput = document.createElement('input');
  impInput.type = 'file';
  // 判別は中身(magic)でやるので accept は誤選択を減らすためだけの補助。
  // ⚠ ここに .zip が無いと、**受理器が動いてもファイルを選べない**
  // (accept を厳格に効かせるブラウザ / OS のピッカーがある)── 救出経路が
  // 実装されているのに到達不能、という穴になる
  // ⚠ **manifest が宣言する拡張子をここにも並べる** ── `file_handlers` で
  // `.md` を宣言しながらピッカーで選べない、は宣言と実体のずれである
  impInput.accept = '.html,.htm,.zip,.md,.markdown,text/html,application/zip,text/markdown';
  // md は複数選択できる(1 件ずつ entry になる)。PKC2 の書出しが複数来たときは
  // import-file.ts が断る
  impInput.multiple = true;
  impInput.hidden = true;
  impInput.setAttribute('data-pkc-field', 'import-input');
  topbar.append(impInput);

  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  /**
   * 🔑 **導線の再考**(user 指示 2026-08-03「PKC2 の導線設計も再考する形で」)。
   * サイドバーの先頭は **絞り込み**にする ── ノートが増えたときに真っ先に要るのは
   * 「作る」ではなく「**探す**」である(PKC3 にはこれまで検索導線が 1 つも無かった)。
   * 作成は 6 ボタン常置をやめ、上部の役割メニューと同じ流儀で **1 つに畳む**。
   */
  const createBar = document.createElement('div');
  createBar.setAttribute('data-pkc-region', 'create-bar');

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.setAttribute('data-pkc-field', 'entry-filter');
  filter.placeholder = '絞り込み';
  filter.title = '題名で絞り込みます(Esc で消す)';
  // ⚠ `placeholder` は名前ではない ── 値を入れると読み上げから消える(review L-8)
  filter.setAttribute('aria-label', '題名で絞り込む');
  createBar.append(filter);

  const newMenu = document.createElement('details');
  newMenu.setAttribute('data-pkc-menu', '新規');
  const newHead = document.createElement('summary');
  newHead.setAttribute('data-pkc-field', 'menu-label');
  newHead.textContent = '新規';
  const newItems = document.createElement('div');
  newItems.setAttribute('data-pkc-menu-items', '');
  newMenu.append(newHead, newItems);
  for (const { archetype, label } of CREATE_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'create-entry');
    btn.setAttribute('data-pkc-archetype', archetype);
    btn.textContent = label;
    newItems.append(btn);
  }
  // 📎 添付取込(P4a): file picker は常設 hidden input(動的生成にしない ──
  // user-gesture 要件と smoke の setInputFiles の両方に効く)
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.setAttribute('data-pkc-action', 'attach-file');
  attach.textContent = '+添付';
  newItems.append(attach);
  createBar.append(newMenu);

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachInput.setAttribute('data-pkc-field', 'attach-input');
  // ⚠ **メニューの外**に置く ── メニューを閉じると中の input は描画木から外れ、
  // smoke の setInputFiles が届かない(取込の hidden input と同じ理由)
  createBar.append(attachInput);

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  sidebar.append(createBar, list);

  const detail = document.createElement('main');
  detail.setAttribute('data-pkc-region', 'detail');

  const status = document.createElement('footer');
  status.setAttribute('data-pkc-region', 'status');

  // 既定は空(= 何も出さない)。注意が出たときだけ中身が入る
  const notices = document.createElement('section');
  notices.setAttribute('data-pkc-region', 'notices');
  notices.hidden = true;

  // 既定は空(= 新しい版に気づくまで何も出さない)
  const update = document.createElement('section');
  update.setAttribute('data-pkc-region', 'update');
  update.hidden = true;

  shell.append(topbar, sidebar, detail, update, notices, status);
  root.append(shell);
  // 役割メニューの閉じ方(外側クリック / Escape / 項目のクリック)。
  // ⚠ 枠は 1 度しか作らないので、ここで 1 度張れば足りる
  installMenuDismiss(shell);
  return { topbar, sidebar, detail, status, notices, update };
}
