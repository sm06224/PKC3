/**
 * app の枠(P3 設計メモ §2)。初回に 1 度だけ構築する ── 以後どの region も
 * この枠を作り直さない。機能セレクタは data-pkc-* のみ(PKC2 規約)。
 */
export interface ShellRegions {
  sidebar: HTMLElement;
  detail: HTMLElement;
  status: HTMLElement;
}

export function buildShell(root: HTMLElement): ShellRegions {
  root.textContent = '';
  const shell = document.createElement('div');
  shell.setAttribute('data-pkc-region', 'shell');

  const sidebar = document.createElement('nav');
  sidebar.setAttribute('data-pkc-region', 'sidebar');
  const list = document.createElement('ul');
  list.setAttribute('data-pkc-region', 'entry-list');
  sidebar.append(list);

  const detail = document.createElement('main');
  detail.setAttribute('data-pkc-region', 'detail');

  const status = document.createElement('footer');
  status.setAttribute('data-pkc-region', 'status');

  shell.append(sidebar, detail, status);
  root.append(shell);
  return { sidebar, detail, status };
}
