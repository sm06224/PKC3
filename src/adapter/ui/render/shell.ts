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
import { THEMES } from './theme';

export interface ShellRegions {
  /** 最上部の帯。彩度のある色を置くのはここだけ。 */
  brand: HTMLElement;
  /** 操作の帯(ビュー切替 + コマンド)。 */
  cmdbar: HTMLElement;
  sidebar: HTMLElement;
  detail: HTMLElement;
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
 * 面の切替。⚠ 封印中のものは**ここに出さない**(`features/sealed.ts` が正本)。
 */
const VIEW_BUTTONS: readonly { view: string; label: string }[] = [
  { view: 'detail', label: 'ノート' },
  { view: 'filer', label: 'フォルダ' },
  { view: 'kanban', label: 'かんばん' },
  { view: 'calendar', label: 'カレンダー' },
  { view: 'launcher', label: 'アプリ' },
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

/** 押せるコマンド。**役割ごとに区切って全部並べる**(畳まない)。 */
const COMMAND_GROUPS: readonly {
  readonly items: readonly { action: string; label: string; title?: string }[];
}[] = [
  {
    items: [
      {
        action: 'import-file',
        label: '取り込む',
        title: 'PKC2 の書き出し(HTML / ZIP)と Markdown を取り込みます',
      },
    ],
  },
  {
    items: [
      { action: 'export-archive', label: 'バックアップ', title: '元に戻せる形で保存します' },
      { action: 'export-html', label: '閲覧用 HTML', title: '読むだけの 1 枚にまとめます' },
      { action: 'export-markdown', label: 'Markdown', title: 'Markdown ファイルとして保存します' },
    ],
  },
  {
    items: [
      {
        action: 'purge-orphan-assets',
        label: '使っていない添付を消す',
        title: 'どのノートからも参照されていない添付を削除します(元に戻せません)',
      },
    ],
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
  const spacer = document.createElement('span');
  spacer.setAttribute('data-pkc-field', 'brand-spacer');
  // 🎨 配色 ── **選ぶもの**なので `<select>`(9 つをボタンで並べると帯が埋まる)
  const theme = document.createElement('select');
  theme.setAttribute('data-pkc-action', 'set-theme');
  theme.setAttribute('data-pkc-field', 'theme-select');
  theme.setAttribute('aria-label', '配色');
  theme.title = '配色を選びます';
  for (const t of THEMES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    theme.append(opt);
  }
  brand.append(brandName, brandContext, spacer, theme);

  // ── 操作の帯 ────────────────────────────────────
  const cmdbar = document.createElement('div');
  cmdbar.setAttribute('data-pkc-region', 'cmdbar');
  const group = (): HTMLElement => {
    const g = document.createElement('div');
    g.setAttribute('data-pkc-field', 'cmd-group');
    cmdbar.append(g);
    return g;
  };
  const sep = (): void => {
    const s = document.createElement('span');
    s.setAttribute('data-pkc-field', 'cmd-sep');
    cmdbar.append(s);
  };

  const views = group();
  for (const { view, label } of VIEW_BUTTONS) {
    if (SEALED_VIEWS.includes(view)) continue; // 封印中(features/sealed.ts)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'set-view');
    btn.setAttribute('data-pkc-view', view);
    btn.textContent = label;
    views.append(btn);
  }

  for (const g of COMMAND_GROUPS) {
    sep();
    const host = group();
    for (const { action, label, title } of g.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', action);
      btn.textContent = label;
      if (title) btn.title = title;
      host.append(btn);
    }
  }

  // ⚠ file picker は常設 hidden input(user-gesture 要件と smoke の setInputFiles の
  // 両方に効く)。⚠ **表示される要素の外**に置かない ── 隠れると setInputFiles が届かない
  const impInput = document.createElement('input');
  impInput.type = 'file';
  // 判別は中身(magic)でやるので accept は誤選択を減らす補助。
  // ⚠ ここに .zip が無いと、**受理器が動いてもファイルを選べない**
  impInput.accept = '.html,.htm,.zip,.md,.markdown,text/html,application/zip,text/markdown';
  impInput.multiple = true;
  impInput.hidden = true;
  impInput.setAttribute('data-pkc-field', 'import-input');
  cmdbar.append(impInput);

  // ── サイドバー(一覧)────────────────────────────
  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  // 🔑 **探す**が先、**作る**が後(増えたときに要るのは探すほう)。
  // ⚠ 1 行に詰めると絞り込み欄が潰れて「絞り」しか読めなくなる ── 2 段にする
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
  const create = document.createElement('button');
  create.type = 'button';
  create.setAttribute('data-pkc-action', 'create-entry');
  create.textContent = '新規';
  create.title = '選んだ種類で新しく作ります';
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.setAttribute('data-pkc-action', 'attach-file');
  attach.textContent = '添付';
  attach.title = 'ファイルを取り込んで添付にします';
  createBar.append(kind, create, attach);

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachInput.setAttribute('data-pkc-field', 'attach-input');
  createBar.append(attachInput);

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  sidebar.append(findBar, createBar, list);

  const detail = document.createElement('main');
  detail.setAttribute('data-pkc-region', 'detail');

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

  shell.append(brand, cmdbar, sidebar, detail, inspector, update, notices, status);
  root.append(shell);
  return { brand, cmdbar, sidebar, detail, inspector, status, notices, update };
}
