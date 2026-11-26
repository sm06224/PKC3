/**
 * 🔴 **ノートのページ設定の操作部品**(v4.0 Phase 1 / PR-03 で情報ペインに置いた物を、PR-04 で 1 本に寄せた)。
 *
 * 情報ペインの「ページ設定」の行と、書式の帯の「ページ設定 ▾」のパネルが**同じ部品**を組み、**同じ塗り方**で塗る ──
 * 2 か所で別々に組むと、字・説明・押せる条件が片方だけ変わる(CLAUDE.md §7)。
 *
 * - 印刷レイアウト表示の切替(`toggle-print-layout`)── この端末の見方(`note-layout.ts`)。
 * - このノートの紙面・余白・段組み・字体の 4 つの選択欄(`set-note-layout`)。先頭は常に「アプリの設定に従う」(選ぶとキーが前書きから消える)。
 * - 「すべてアプリの設定に戻す」(`reset-note-layout`)── 個別の指定が 1 つ以上あるときだけ押せる(片道を作らない)。
 *
 * 🔑 値はどちらも**同じ本文**(`state.openBody`。編集中は下書き)の前書きから読む。片方で変えたら state が変わり、
 *   両方が描き直される(= 即座に一致する)。
 * ⚠ 器は使い回す(押す寸前の選択欄を作り直さない)── `ensureNoteLayoutControls` は無いときだけ組む。
 */
import {
  hasNoteLayout,
  NOTE_LAYOUT_FIELDS,
  NOTE_LAYOUT_LABELS,
  noteLayoutChoices,
  type NoteLayoutField,
  type NoteLayoutSpec,
} from '@features/page-layout';
import { isPrintLayoutOn, paintPrintLayoutButton, TOGGLE_PRINT_LAYOUT_ACTION } from './note-layout';
import { plainChoiceLabel } from './settings/default-mark';

/** 4 つの選択欄の `data-pkc-action`。 */
export const SET_NOTE_LAYOUT_ACTION = 'set-note-layout';
/** 「すべてアプリの設定に戻す」の `data-pkc-action`。 */
export const RESET_NOTE_LAYOUT_ACTION = 'reset-note-layout';

export interface NoteLayoutControls {
  readonly toggle: HTMLButtonElement;
  readonly grid: HTMLElement;
  readonly reset: HTMLButtonElement;
}

/**
 * 器(`box`)の中に部品が無ければ組む。在ればそのまま返す。
 * @param toggleField 切替ボタンの `data-pkc-field`(情報ペインとパネルで名前を分ける ── smoke と test が場所を見分ける)
 */
export function ensureNoteLayoutControls(box: HTMLElement, toggleField: string): NoteLayoutControls {
  const doc = box.ownerDocument;
  const toggle0 = box.querySelector<HTMLButtonElement>(`[data-pkc-action="${TOGGLE_PRINT_LAYOUT_ACTION}"]`);
  const reset0 = box.querySelector<HTMLButtonElement>(`[data-pkc-action="${RESET_NOTE_LAYOUT_ACTION}"]`);
  const grid0 = box.querySelector<HTMLElement>('[data-pkc-field="inspector-note-layout"]');
  if (toggle0 !== null && reset0 !== null && grid0 !== null) return { toggle: toggle0, grid: grid0, reset: reset0 };
  box.textContent = '';
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('data-pkc-action', 'toggle-print-layout'); // = TOGGLE_PRINT_LAYOUT_ACTION(字のまま書く ── 出口の全数検査が綴りで追う)
  toggle.setAttribute('data-pkc-field', toggleField);
  const grid = doc.createElement('span');
  grid.setAttribute('data-pkc-field', 'inspector-note-layout');
  for (const f of NOTE_LAYOUT_FIELDS) {
    const label = doc.createElement('label');
    const name = doc.createElement('span');
    name.textContent = NOTE_LAYOUT_LABELS[f];
    const sel = doc.createElement('select');
    sel.setAttribute('data-pkc-action', 'set-note-layout'); // = SET_NOTE_LAYOUT_ACTION(字のまま書く ── 出口の全数検査が綴りで追う)
    sel.setAttribute('data-pkc-note-layout-field', f);
    sel.setAttribute('aria-label', `このノートの${NOTE_LAYOUT_LABELS[f]}`);
    const inherit = doc.createElement('option');
    inherit.value = '';
    inherit.textContent = 'アプリの設定に従う';
    sel.append(inherit);
    for (const c of noteLayoutChoices(f)) {
      const opt = doc.createElement('option');
      opt.value = c.id;
      opt.textContent = plainChoiceLabel(c.label);
      sel.append(opt);
    }
    label.append(name, sel);
    grid.append(label);
  }
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.setAttribute('data-pkc-action', 'reset-note-layout'); // = RESET_NOTE_LAYOUT_ACTION(字のまま書く ── 出口の全数検査が綴りで追う)
  reset.textContent = 'すべてアプリの設定に戻す';
  box.append(toggle, grid, reset);
  return { toggle, grid, reset };
}

/**
 * 部品を塗る。⚠ 値が変わらないときは書かない(描き直しのたびに選択欄を鳴らさない)。
 * @param locked 押せない(本文が届いていない・書けない状態)
 * @param withNote 押せないときの説明に理由を添える(無ければ素の説明)
 */
export function paintNoteLayoutControls(
  c: NoteLayoutControls,
  spec: NoteLayoutSpec,
  locked: boolean,
  withNote: (base: string) => string,
): void {
  paintPrintLayoutButton(c.toggle, isPrintLayoutOn(c.toggle.ownerDocument.documentElement));
  for (const sel of c.grid.querySelectorAll<HTMLSelectElement>(`select[data-pkc-action="${SET_NOTE_LAYOUT_ACTION}"]`)) {
    const f = sel.getAttribute('data-pkc-note-layout-field') as NoteLayoutField;
    const v = spec[f] ?? '';
    if (sel.value !== v) sel.value = v;
    if (sel.disabled !== locked) sel.disabled = locked;
    const base = `このノートだけの${NOTE_LAYOUT_LABELS[f]}です。「アプリの設定に従う」を選ぶと、本文の先頭の情報から消えます`;
    const tip = locked ? withNote(base) : base;
    if (sel.title !== tip) sel.title = tip;
  }
  const any = hasNoteLayout(spec);
  const off = locked || !any;
  if (c.reset.disabled !== off) c.reset.disabled = off;
  const resetBase = any
    ? 'このノートのページ設定をすべて消して、アプリの設定に従うように戻します'
    : 'このノートだけのページ設定はありません';
  const resetTip = locked ? withNote(resetBase) : resetBase;
  if (c.reset.title !== resetTip) c.reset.title = resetTip;
}
