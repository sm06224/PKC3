/**
 * app の枠(P3 設計メモ §2)。初回に 1 度だけ構築する ── 以後どの region も
 * この枠を作り直さない。機能セレクタは data-pkc-* のみ(PKC2 規約)。
 */
export interface ShellRegions {
  topbar: HTMLElement;
  sidebar: HTMLElement;
  detail: HTMLElement;
  status: HTMLElement;
}

const VIEW_BUTTONS: readonly { view: string; label: string }[] = [
  { view: 'detail', label: '詳細' },
  { view: 'kanban', label: 'かんばん' },
  { view: 'calendar', label: 'カレンダー' },
  { view: 'filer', label: 'ファイラ' },
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
  // 🧹 未参照 asset の掃除(P4b)── **明示 purge のみ**(自動 GC はしない)。
  // status footer は textContent 上書き運用なのでボタンを置けない → topbar 端
  const purge = document.createElement('button');
  purge.type = 'button';
  purge.setAttribute('data-pkc-action', 'purge-orphan-assets');
  purge.textContent = '添付の整理';
  topbar.append(purge);
  // 📥 PKC2 取込(P6b): file picker は常設 hidden input(添付と同じ流儀 ──
  // user-gesture 要件と smoke の setInputFiles の両方に効く)
  const imp = document.createElement('button');
  imp.type = 'button';
  imp.setAttribute('data-pkc-action', 'import-pkc2');
  imp.textContent = 'PKC2 を取込';
  topbar.append(imp);
  const impInput = document.createElement('input');
  impInput.type = 'file';
  impInput.hidden = true;
  impInput.setAttribute('data-pkc-field', 'import-input');
  topbar.append(impInput);

  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  const createBar = document.createElement('div');
  createBar.setAttribute('data-pkc-region', 'create-bar');
  for (const { archetype, label } of CREATE_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'create-entry');
    btn.setAttribute('data-pkc-archetype', archetype);
    btn.textContent = label;
    createBar.append(btn);
  }
  // 📎 添付取込(P4a): file picker は常設 hidden input(動的生成にしない ──
  // user-gesture 要件と smoke の setInputFiles の両方に効く)
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.setAttribute('data-pkc-action', 'attach-file');
  attach.textContent = '+添付';
  createBar.append(attach);
  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  attachInput.setAttribute('data-pkc-field', 'attach-input');
  createBar.append(attachInput);

  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  sidebar.append(createBar, list);

  const detail = document.createElement('main');
  detail.setAttribute('data-pkc-region', 'detail');

  const status = document.createElement('footer');
  status.setAttribute('data-pkc-region', 'status');

  shell.append(topbar, sidebar, detail, status);
  root.append(shell);
  return { topbar, sidebar, detail, status };
}
