/**
 * 🔴 **ノートのタブ列**(#1982 段 5-3)── 中央ペインの本文の**すぐ上**に出る。2 枚以上のときだけ。
 *
 * - 1 枚以下では**描かない**(`hidden` + 中身なし。単独で使う人の版面を動かさない)
 * - 並びは `orderTabs`(ピン留めが先頭)。ピン留めは #1377 が正本で、タブ側には持たない(`notePins` の写しを読むだけ)
 * - 押すと `activate-note-tab`、× は `close-note-tab`(受け手は `binder.ts`。ここは dispatch しない ── 層規約)
 * - 題名・状態の印は `textContent` だけ(題名は user の入力 ── HTML として読まない)。
 *   印(ピン・編集中の ●)は `aria-hidden` で、読み上げの名前は `aria-label` に 1 本で渡す
 * - 現在地は形(左端の線・太字。`app.css`)。矢印キー・中クリック・右クリックは段 5-4
 * 🔑 描き直しは姿(指紋)が変わったときだけ ── 押している最中に作り直さない。
 * ⚠ タブ 1 枚は「選ぶ」ボタンと「閉じる」ボタンの 2 つ(ボタンの中にボタンを入れない)。
 *   包みは `role="presentation"` で、タブの列の子として数えられない。
 */
import type { AppState } from '@adapter/state/app-state';
import { orderTabs, visible } from '@features/nav/note-tabs';
import { markTab, markTablist } from './tabs-a11y';

export const NOTE_TABS_REGION = 'note-tabs';
export const NOTE_TAB_EXTERNAL_LABEL = '別ウィンドウで開いています';

export class NoteTabsBar {
  private lastPrint = '';

  constructor(private readonly host: HTMLElement) {
    host.hidden = true;
    markTablist(host);
    host.setAttribute('aria-label', '開いているノート');
  }

  render(state: AppState): void {
    const set = state.noteTabs;
    const show = visible(set);
    const ordered = show ? orderTabs(set.tabs, state.notePins) : [];
    const editing = state.phase === 'editing' ? state.selectedLid : null;
    const print = JSON.stringify(
      ordered.map((t) => [
        t.lid,
        state.entryMetas.get(t.lid)?.title ?? '',
        set.active === t.lid,
        state.notePins.has(t.lid),
        editing === t.lid,
        t.external,
      ]),
    );
    if (print === this.lastPrint) return;
    this.lastPrint = print;
    this.host.hidden = !show;
    this.host.textContent = '';
    if (!show) return;

    for (const t of ordered) {
      const title = state.entryMetas.get(t.lid)?.title ?? '';
      const shown = title === '' ? '(無題)' : title;
      const pinned = state.notePins.has(t.lid);
      const isEditing = editing === t.lid;
      const current = set.active === t.lid;

      const cell = document.createElement('div');
      cell.setAttribute('role', 'presentation');
      cell.setAttribute('data-pkc-field', 'note-tab');
      cell.setAttribute('data-pkc-entry', t.lid);
      if (current) cell.setAttribute('data-pkc-active', '');

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('data-pkc-action', 'activate-note-tab');
      tab.setAttribute('data-pkc-field', 'note-tab-select');
      tab.setAttribute('data-pkc-entry', t.lid);
      markTab(tab, current);
      const notes: string[] = [];
      if (pinned) notes.push('ピン留め');
      if (isEditing) notes.push('編集中');
      if (t.external) notes.push(NOTE_TAB_EXTERNAL_LABEL);
      tab.setAttribute('aria-label', notes.length === 0 ? shown : `${shown}(${notes.join('・')})`);
      tab.title = t.external ? `${shown}(${NOTE_TAB_EXTERNAL_LABEL})` : shown;

      if (pinned) {
        const pin = document.createElement('span');
        pin.setAttribute('data-pkc-field', 'note-tab-pin');
        pin.setAttribute('aria-hidden', 'true');
        tab.append(pin);
      }
      const label = document.createElement('span');
      label.setAttribute('data-pkc-field', 'note-tab-title');
      label.textContent = shown;
      tab.append(label);
      if (isEditing) {
        const dot = document.createElement('span');
        dot.setAttribute('data-pkc-field', 'note-tab-dirty');
        dot.setAttribute('aria-hidden', 'true');
        dot.textContent = '●';
        tab.append(dot);
      }
      if (t.external) {
        const ext = document.createElement('span');
        ext.setAttribute('data-pkc-field', 'note-tab-external');
        ext.textContent = NOTE_TAB_EXTERNAL_LABEL;
        tab.append(ext);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('data-pkc-action', 'close-note-tab');
      close.setAttribute('data-pkc-field', 'note-tab-close');
      close.setAttribute('data-pkc-entry', t.lid);
      close.setAttribute('aria-label', 'タブを閉じる');
      close.title = `「${shown}」のタブを閉じます(ノートは消えません)`;
      close.textContent = '×';

      cell.append(tab, close);
      this.host.append(cell);
    }
  }
}
