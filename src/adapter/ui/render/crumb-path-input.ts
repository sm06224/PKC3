/**
 * パンくず(アドレスバー)を「パスを直接打つ入力」に切り替える DOM の部品(#1982 A4)。
 *
 * 🔑 路の読み書き(字 ↔ フォルダ、候補の見分け)は `@features/filer/folder-path` の 1 か所。ここは DOM だけ。
 * 🔑 入力に切り替えるときは、段のボタンを**外して取っておき**、閉じるときに**そのまま戻す**
 *   (段の `data-pkc-drop` / `enter-folder` の働きを作り直さない)。面が組み直されたときは
 *   `captureCrumbInput` で打ちかけの字と焦点を運び、新しい枠へ `openCrumbInput` で戻す。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  currentFolderPathText,
  filterFolderPathCandidates,
  listFolderPathCandidates,
} from '@features/filer/folder-path';

export const CRUMB_INPUT_FIELD = 'crumb-input';
export const CRUMB_LIST_ID = 'pkc-crumb-path-candidates';
/** 候補の上限(`<datalist>` に何千も並べない)。 */
const CANDIDATE_LIMIT = 100;

const saved = new WeakMap<HTMLElement, Node[]>();

export const crumbInputOf = (scope: ParentNode): HTMLInputElement | null =>
  scope.querySelector<HTMLInputElement>(`input[data-pkc-field="${CRUMB_INPUT_FIELD}"]`);

export function fillCrumbCandidates(
  input: HTMLInputElement,
  state: Pick<AppState, 'entryMetas' | 'relations'>,
  /** 絞る字(既定は欄の字。開いた直後は全部を出す ── 欄の字は現在地なので、絞ると現在地しか出ない)。 */
  filterText: string = input.value,
): void {
  const list = input.parentElement?.querySelector('datalist');
  if (list == null) return;
  const cands = filterFolderPathCandidates(
    listFolderPathCandidates(state.entryMetas, state.relations),
    filterText,
    CANDIDATE_LIMIT,
  );
  list.textContent = '';
  for (const c of cands) {
    const o = document.createElement('option');
    o.value = c.label;
    list.append(o);
  }
}

/** 枠(`crumb-path`)を入力に切り替える。返すのは作った入力欄(焦点は呼び手が決める)。 */
export function openCrumbInput(
  path: HTMLElement,
  state: Pick<AppState, 'entryMetas' | 'relations' | 'scopeLid'>,
  text?: string,
): HTMLInputElement {
  const existing = crumbInputOf(path);
  if (existing !== null) return existing;
  saved.set(path, [...path.childNodes]);
  path.replaceChildren();
  path.setAttribute('data-pkc-editing', '');
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('data-pkc-field', CRUMB_INPUT_FIELD);
  input.setAttribute('aria-label', 'フォルダのパス(Enter で移動、Esc でやめる)');
  input.setAttribute('list', CRUMB_LIST_ID);
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;
  input.placeholder = 'ルート/フォルダ/フォルダ';
  input.value = text ?? currentFolderPathText(state.scopeLid, state.entryMetas, state.relations);
  const list = document.createElement('datalist');
  list.id = CRUMB_LIST_ID;
  path.append(input, list);
  fillCrumbCandidates(input, state, text ?? '');
  return input;
}

/** 入力をやめて、取っておいた段をそのまま戻す。 */
export function closeCrumbInput(path: HTMLElement): void {
  const back = saved.get(path);
  saved.delete(path);
  path.removeAttribute('data-pkc-editing');
  if (back !== undefined) path.replaceChildren(...back);
}

export interface KeptCrumbInput {
  text: string;
  focused: boolean;
  start: number | null;
  end: number | null;
}

/** 面を組み直す前に、打ちかけの字と焦点を採る(無ければ `null`)。 */
export function captureCrumbInput(region: ParentNode): KeptCrumbInput | null {
  const input = crumbInputOf(region);
  if (input === null) return null;
  return {
    text: input.value,
    focused: input.ownerDocument.activeElement === input,
    start: input.selectionStart,
    end: input.selectionEnd,
  };
}

export function restoreCrumbInput(
  path: HTMLElement,
  state: Pick<AppState, 'entryMetas' | 'relations' | 'scopeLid'>,
  kept: KeptCrumbInput,
): void {
  const input = openCrumbInput(path, state, kept.text);
  if (kept.focused) {
    input.focus();
    if (kept.start !== null && kept.end !== null) input.setSelectionRange(kept.start, kept.end);
  }
}
