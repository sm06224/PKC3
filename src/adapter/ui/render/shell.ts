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
import { iconButton } from './icons';
import { BROWSE_TABS } from './browse';

export interface ShellRegions {
  /** 最上部の帯。彩度のある色を置くのはここだけ。 */
  brand: HTMLElement;
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
}

/**
 * 🔴 **上の帯には「面の切替」を置かない**(P8 段⑤、user 指摘
 * 「上のメニューと左ペインのメニューにかぶりがある / 分けもなくて、扱いにくい」)。
 *
 * フォルダとアプリは「見る場所」ではなく**探し方**なので、左の列のタブへ移した
 * (`browse.ts`)。上に残るのは**アプリ全体**に対する 1 つだけ ── 設定である。
 */
const VIEW_BUTTONS: readonly { view: string; label: string }[] = [
  { view: 'settings', label: '設定' },
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

  // ── 最上部の帯 ──────────────────────────────────
  const brand = document.createElement('header');
  brand.setAttribute('data-pkc-region', 'brand');
  const brandName = document.createElement('span');
  brandName.setAttribute('data-pkc-field', 'brand-name');
  brandName.textContent = 'PKC3';
  const brandContext = document.createElement('span');
  brandContext.setAttribute('data-pkc-field', 'brand-context');
  // ⚠ **薄く保つ**(user 指示 2026-08-03「最上のヘッドラインはもっと薄くてもいい、
  // 邪魔」)── 出すのは名前と現在地、それに**アプリ全体**の操作(設定)だけ。
  // ⚠ かつてここは「押すものはここに置かない」と書きながら直後に設定ボタンを
  //    置いていた(P8 段㉕ で実態に合わせた)
  const spacer = document.createElement('span');
  spacer.setAttribute('data-pkc-field', 'brand-spacer');
  brand.append(brandName, brandContext, spacer);

  // ⚠ 上の帯に置くのは**アプリ全体**のものだけ(いまは設定 1 つ)
  for (const { view, label } of VIEW_BUTTONS) {
    if (SEALED_VIEWS.includes(view)) continue;
    const btn = iconButton('set-view', label, `set-view:${view}`);
    btn.setAttribute('data-pkc-view', view);
    brand.append(btn);
  }

  // ── サイドバー(一覧)────────────────────────────
  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  /**
   * 🔑 **探し方のタブ**(P8 段⑤)。フォルダもアプリも「探し方」なので、
   * 中央のビューではなくここに置く ── 中央は常に「開いているノート」。
   */
  const tabs = document.createElement('div');
  tabs.setAttribute('data-pkc-region', 'browse-tabs');
  for (const { mode, label, icon } of BROWSE_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'set-browse');
    btn.setAttribute('data-pkc-browse', mode);
    const ic = document.createElement('span');
    ic.setAttribute('data-pkc-icon', '');
    ic.setAttribute('aria-hidden', 'true');
    ic.textContent = icon;
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

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.setAttribute('data-pkc-field', 'entry-filter');
  filter.placeholder = '絞り込み';
  filter.title = '題名で絞り込みます(Esc で消えます)';
  // ⚠ `placeholder` は名前ではない ── 値を入れると読み上げから消える
  filter.setAttribute('aria-label', '題名で絞り込む');
  findBar.append(filter);

  /**
   * 🔑 **新規は「何を作るか」を選ばせる `<select>` + 作るボタン**。
   * ボタンを 5 つ並べると幅を食い、畳むと隠れる ── 業務画面の作法では
   * 「選ぶもの」は select、「起きるもの」はボタンである。
   */
  const kind = document.createElement('select');
  kind.setAttribute('data-pkc-field', 'create-kind');
  kind.setAttribute('aria-label', '作るものの種類');
  for (const { archetype, label } of CREATE_BUTTONS) {
    if (SEALED_ARCHETYPES.includes(archetype)) continue; // 封印中
    const opt = document.createElement('option');
    opt.value = archetype;
    opt.textContent = label;
    kind.append(opt);
  }
  const create = iconButton('create-entry', '新規');
  create.title = '選んだ種類で新しく作ります';
  const attach = iconButton('attach-file', '添付');
  attach.title = 'ファイルを取り込んで添付にします';
  createBar.append(kind, create, attach);

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
  sidebar.append(tabs, findBar, createBar, browseHost, collectionBar);

  // ── 中央(いま開いているもの)────────────────────────
  // 🔑 本文と**追記欄は別の器**にする(P8 段⑧)。本文は書き換わるたびに作り直すので、
  // 同じ器に入れると**打ちかけの追記が消え、focus も飛ぶ**(追記のたびに起きる)。
  const center = document.createElement('main');
  center.setAttribute('data-pkc-region', 'center');
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const append = document.createElement('div');
  append.setAttribute('data-pkc-region', 'append');
  append.hidden = true;
  center.append(detail, append);

  // ── 右(付随情報)────────────────────────────────
  const inspector = document.createElement('aside');
  inspector.setAttribute('data-pkc-region', 'inspector');

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

  shell.append(brand, sidebar, center, inspector, update, notices, status);
  root.append(shell);
  return { brand, browseHost, sidebar, center, detail, append, inspector, status, notices, update };
}
