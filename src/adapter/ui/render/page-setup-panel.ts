/**
 * 🔴 **書式の帯の「ページ設定 ▾」のパネル**(v4.0 Phase 1 / PR-04。ビジョン 3-B)。
 *
 * 編集中のノートのページ設定(印刷レイアウト表示・用紙・余白・段組み・字体・すべてアプリの設定に戻す)を、
 * 帯から離れずに変えられる小さなパネル。
 *
 * ## 1 本の正本
 *
 * - 部品と塗り方は情報ペインと**同じ** `note-layout-controls.ts`。押す先も同じ action(`toggle-print-layout` /
 *   `set-note-layout` / `reset-note-layout`)── 書き換えは reducer の `SET_NOTE_LAYOUT` の 1 本で、編集中は下書きの前書きを書く。
 * - 値は state の本文(編集中は下書き)から読む。state が変わるたびに描き直す(binder が `onState` で呼ぶ)ので、
 *   情報ペインで変えてもこちらで変えても、もう片方が即座に一致する。
 *
 * ## 開け閉め(native の置き換えの作法 ── `.claude/rules/src-invariants.md` §4)
 *
 * - 開くと最初の部品へ焦点を入れる。閉じると「ページ設定 ▾」へ焦点を返す。
 * - `Escape` で閉じる。⚠ 伝播を止める(止めないと、同じ `Escape` が編集をやめる側へ流れる)。
 * - パネルの外を押すと閉じる。編集を抜けた・帯が消えたときも閉じる(残さない)。
 */
import type { AppState } from '@adapter/state/app-state';
import { blockedActionNote, noteLayoutBlockReason } from '@adapter/state/app-state';
import { EMPTY_NOTE_LAYOUT, noteLayoutApplies, readNoteLayout } from '@features/page-layout';
import { ensureNoteLayoutControls, paintNoteLayoutControls } from './note-layout-controls';
import { PAGE_SETUP_ACTION } from './format-bar';

/** パネルの `data-pkc-region`。 */
export const PAGE_SETUP_REGION = 'page-setup-panel';
/** パネルの中の切替ボタンの `data-pkc-field`(情報ペインの `inspector-print-layout` と見分ける)。 */
export const PAGE_SETUP_TOGGLE_FIELD = 'page-setup-print-layout';
/** 閉じるボタンの `data-pkc-action`。 */
export const CLOSE_PAGE_SETUP_ACTION = 'close-page-setup';

interface OpenPanel {
  readonly panel: HTMLElement;
  readonly anchor: HTMLElement;
  readonly dispose: () => void;
}

const opened = new WeakMap<HTMLElement, OpenPanel>();

/** いま開いているパネル(無ければ `null`)。 */
export function pageSetupPanelOf(root: HTMLElement): HTMLElement | null {
  return opened.get(root)?.panel ?? null;
}

/** 本文の器の中の位置へ置く(押した ▾ の下。画面からはみ出すなら左へ寄せ、下が足りなければ上へ)。 */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const view = panel.ownerDocument.defaultView;
  const r = anchor.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const vw = view?.innerWidth ?? 0;
  const vh = view?.innerHeight ?? 0;
  const margin = 8;
  let x = r.right - w;
  if (x + w > vw - margin) x = vw - margin - w;
  x = Math.max(margin, x);
  let y = r.bottom + 4;
  if (vh > 0 && y + h > vh - margin) y = Math.max(margin, r.top - 4 - h);
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
}

/**
 * パネルを state に合わせて塗る。⚠ 開いていなければ何もしない。
 * 🔑 ノートが替わった・編集を抜けた・▾ が画面から消えたときは閉じる(押す先の無いパネルを残さない)。
 */
export function paintPageSetupPanel(root: HTMLElement, state: AppState): void {
  const cur = opened.get(root);
  if (cur === undefined) return;
  const lid = state.selectedLid;
  const meta = lid === null ? undefined : state.entryMetas.get(lid);
  if (!cur.anchor.isConnected || state.phase !== 'editing' || lid === null || meta === undefined || !noteLayoutApplies(lid, meta.archetype)) {
    closePageSetupPanel(root, false);
    return;
  }
  const body = state.openBody?.lid === lid ? state.openBody.body : null;
  const spec = body === null ? EMPTY_NOTE_LAYOUT : readNoteLayout(body);
  const box = cur.panel.querySelector<HTMLElement>('[data-pkc-field="page-setup-controls"]');
  if (box === null) return;
  const controls = ensureNoteLayoutControls(box, PAGE_SETUP_TOGGLE_FIELD);
  const blocked = noteLayoutBlockReason(state, lid);
  // ⚠ 理由の字は情報ペインと同じ(phase の断りは言い切りの `blockedActionNote`)
  const note = blocked === null ? '' : (blockedActionNote(state.phase) ?? blocked);
  paintNoteLayoutControls(controls, spec, blocked !== null || body === null, (base) =>
    note === '' ? base : `${base}\n${note}`,
  );
}

/** ▾ のボタン(帯の物)の開閉の印をそろえる。 */
function markExpanded(root: HTMLElement, open: boolean): void {
  for (const b of root.querySelectorAll<HTMLElement>(`[data-pkc-action="${PAGE_SETUP_ACTION}"]`)) {
    if (b.getAttribute('role') !== null) continue; // 一覧の項目は開閉の状態を持たない
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

/**
 * パネルを開く。既に開いていれば閉じる(▾ は開閉の切替)。
 * @returns 開いたら真
 */
export function togglePageSetupPanel(root: HTMLElement, anchor: HTMLElement, state: AppState): boolean {
  if (opened.has(root)) {
    closePageSetupPanel(root, true);
    return false;
  }
  const doc = root.ownerDocument;
  const panel = doc.createElement('div');
  panel.setAttribute('data-pkc-region', PAGE_SETUP_REGION);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'ページ設定');
  panel.id = 'pkc-page-setup-panel';
  const head = doc.createElement('div');
  head.setAttribute('data-pkc-field', 'page-setup-head');
  const title = doc.createElement('span');
  title.setAttribute('data-pkc-field', 'page-setup-title');
  title.textContent = 'ページ設定';
  const close = doc.createElement('button');
  close.type = 'button';
  close.setAttribute('data-pkc-action', 'close-page-setup'); // = CLOSE_PAGE_SETUP_ACTION(字のまま書く ── 出口の全数検査が綴りで追う)
  close.setAttribute('aria-label', 'ページ設定を閉じる');
  close.title = 'ページ設定を閉じます';
  close.textContent = '×';
  head.append(title, close);
  const box = doc.createElement('div');
  box.setAttribute('data-pkc-field', 'page-setup-controls');
  panel.append(head, box);
  root.append(panel);
  // ⚠ 開閉と外を押したときの片づけは、パネルの寿命と同じ(閉じるときに必ず外す)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.isComposing) return;
    ev.preventDefault();
    ev.stopPropagation();
    closePageSetupPanel(root, true);
  };
  const onDown = (ev: Event): void => {
    const t = ev.target as Node | null;
    if (t === null || panel.contains(t) || anchor.contains(t)) return;
    closePageSetupPanel(root, false);
  };
  panel.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onDown, true);
  const onResize = (): void => place(panel, anchor);
  doc.defaultView?.addEventListener('resize', onResize);
  opened.set(root, {
    panel,
    anchor,
    dispose: () => {
      panel.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointerdown', onDown, true);
      doc.defaultView?.removeEventListener('resize', onResize);
    },
  });
  markExpanded(root, true);
  for (const b of root.querySelectorAll<HTMLElement>(`[data-pkc-action="${PAGE_SETUP_ACTION}"]`)) b.setAttribute('aria-controls', panel.id);
  paintPageSetupPanel(root, state);
  if (!opened.has(root)) return false; // 塗る段で閉じた(対象のノートでない)
  place(panel, anchor);
  // ⚠ 焦点は最初の設定の部品へ(閉じるボタン「×」ではない ── 開いてすぐ Enter で閉じてしまわない)
  box.querySelector<HTMLElement>('button, select')?.focus();
  return true;
}

/** パネルを閉じる。@param returnFocus 真なら「ページ設定 ▾」へ焦点を返す */
export function closePageSetupPanel(root: HTMLElement, returnFocus: boolean): void {
  const cur = opened.get(root);
  if (cur === undefined) return;
  opened.delete(root);
  cur.dispose();
  const hadFocus = cur.panel.contains(root.ownerDocument.activeElement);
  cur.panel.remove();
  markExpanded(root, false);
  if ((returnFocus || hadFocus) && cur.anchor.isConnected) cur.anchor.focus();
}
