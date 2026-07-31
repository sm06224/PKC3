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

  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  sidebar.append(list);

  const detail = document.createElement('main');
  detail.setAttribute('data-pkc-region', 'detail');

  const status = document.createElement('footer');
  status.setAttribute('data-pkc-region', 'status');

  shell.append(topbar, sidebar, detail, status);
  root.append(shell);
  return { topbar, sidebar, detail, status };
}
