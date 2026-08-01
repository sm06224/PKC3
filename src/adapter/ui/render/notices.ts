/**
 * 複数件の注意を**全部**見せる面(P6c review H-2)。
 *
 * ⚠ これが無かった間、`notify` の 1 行に `notes[0]` だけを載せていたため
 * **2 件目以降はどこにも出力されていなかった**(console にも state にも残らない)。
 * 段②までは注意が 1〜2 件だったので実害が出ていなかっただけで、段④ で件数が
 * 内側 bundle 数に比例した瞬間に効く ── 「欠損は必ず warning で可視化する」の
 * 出口が塞がっていた。
 *
 * user が閉じるまで残す(status footer は次の操作で上書きされて消えるので、
 * 「取り込んだ後に読み返す」ができない)。
 */
export function showNotices(region: HTMLElement, title: string, notes: readonly string[]): void {
  region.textContent = '';
  if (notes.length === 0) {
    region.hidden = true;
    return;
  }

  const head = document.createElement('div');
  head.setAttribute('data-pkc-field', 'notices-title');
  head.textContent = `${title}(${notes.length} 件)`;

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'dismiss-notices');
  close.textContent = '閉じる';
  head.append(close);

  const list = document.createElement('ul');
  for (const n of notes) {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-notice', '');
    li.textContent = n;
    list.append(li);
  }

  region.append(head, list);
  region.hidden = false;
}

/** 閉じる(次の取込で再び出る)。 */
export function clearNotices(region: HTMLElement): void {
  region.textContent = '';
  region.hidden = true;
}
