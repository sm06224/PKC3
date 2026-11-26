/**
 * 🔴 **ノート単位のページ設定を中央の本文へ当てる / 印刷レイアウト表示の保存と適用**(v4.0 Phase 1 / PR-03)。
 *
 * 意味論(どのキーが何を変えるか・アプリの設定との重ね方)は `features/page-layout.ts`。
 * ここが持つのは **DOM への適用**と、**印刷レイアウト表示の保存**(この端末の見方)だけである。
 *
 * ## 当て方の規律
 *
 * - 🔴 **`:root` を汚さない** ── ノートの上書きは、そのノートの中央の本文の器(`[data-pkc-view-pane="detail"]`)
 *   にだけ当てる。ノートを閉じた・指定の無いノートへ移った・設定の画面などへ移ったら確実に外す(他のノートへ漏らさない)。
 * - 🔴 **値が変わらないときは `setAttribute` / `style.setProperty` を呼ばない** ── 器には段組みの見張り
 *   (`read-columns.ts` の MutationObserver)が付いており、同じ値の書き込みでも鳴って強制レイアウトを払う
 *   (`detail.ts` の `mode` の setter と同じ規律)。
 * - `@page`(`<style data-pkc-field="page-paper">`)は**開いているノートの有効な紙面 + 余白**へ載せ替え、
 *   ノートを閉じたらアプリ全体の紙面(余白なし = 従来どおり)へ戻す。
 *
 * ## 印刷レイアウト表示
 *
 * - ⚠ **flag ではない**(15 枠を使わない)── 正規設定。保存は `pkc3.print-layout`(`'1'` = 入、それ以外 = 切、既定は切)。
 * - ⚠ **container に入れない** ── ノートのデータではなく、この端末の見方である(`page-format.ts` と同じ)。
 * - 印は `<html>` の `data-pkc-print-layout="1"`(切のときは属性なし)。紙の寸法は器の CSS 変数で渡す。
 */
import { currentFont, FONT_STORAGE_KEY } from './appearance-choice';
import { applyPaper, currentPageFormat, PAGE_FORMAT_STORAGE_KEY } from './page-format';
import { currentReadColumns, NOTE_COLUMNS_ATTR, READ_COLUMNS_STORAGE_KEY, READ_COLUMNS_VAR } from './read-columns';
import { fontSpec } from '@features/appearance-choice';
import { PAGE_FORMAT_ATTR, pageFormatSpec } from '@features/page-format';
import {
  EMPTY_NOTE_LAYOUT,
  noteLayoutApplies,
  paperSheetSpec,
  readNoteLayout,
  resolveEffectiveLayout,
  sheetPadding,
  type EffectiveLayout,
  type NoteLayoutSpec,
} from '@features/page-layout';
import { readColumnsSpec, type ReadColumns } from '@features/read-columns';
import type { AppState } from '@adapter/state/app-state';

/** 印刷レイアウト表示の保存の鍵(1 鍵だけ ── `pkc3.page-format` と同じ作法)。 */
export const PRINT_LAYOUT_STORAGE_KEY = 'pkc3.print-layout';
/** 印刷レイアウト表示の印(`<html>` に付く)。CSS と smoke が読む。⚠ 綴りの正本は `read-columns.ts`(段組みの判定が読む)。 */
export { NOTE_COLUMNS_ATTR, PRINT_LAYOUT_ATTR } from './read-columns';
import { PRINT_LAYOUT_ATTR } from './read-columns';
/** ノートが字体を指定しているときだけ器に付く印(`app.css` がこれを見て `font-family: var(--font)` を当て直す)。 */
export const NOTE_FONT_ATTR = 'data-pkc-note-font';
/** 印刷レイアウト表示で紙の中の段数(2 以上のときだけ器に付く)。 */
export const SHEET_COLS_ATTR = 'data-pkc-sheet-cols';
/** 画面用のフォーマットなので A4 縦を紙の基準にしているときだけ器に付く印。 */
export const PAPER_FALLBACK_ATTR = 'data-pkc-paper-fallback';

/** 紙の寸法を渡す CSS 変数(器に書く)。 */
export const PAPER_W_VAR = '--pkc-paper-w';
export const PAPER_H_VAR = '--pkc-paper-h';
export const PAPER_PAD_VAR = '--pkc-paper-pad';
export const SHEET_COLS_VAR = '--pkc-sheet-cols';

function store(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/** 保存されている印刷レイアウト表示(起動時の初期値)。⚠ 読めなければ切。 */
export function initialPrintLayout(): boolean {
  try {
    return store()?.getItem(PRINT_LAYOUT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** いま印刷レイアウト表示か(**DOM が正本**)。 */
export function isPrintLayoutOn(root: HTMLElement): boolean {
  return root.getAttribute(PRINT_LAYOUT_ATTR) === '1';
}

/** 当てる(保存しない)。⚠ 同じ値なら触らない(`<html>` の属性の見張りを無駄に鳴らさない)。 */
export function applyPrintLayout(root: HTMLElement, on: boolean): void {
  if (isPrintLayoutOn(root) !== on) {
    if (on) root.setAttribute(PRINT_LAYOUT_ATTR, '1');
    else root.removeAttribute(PRINT_LAYOUT_ATTR);
  }
  // 🔑 切替のボタンは state を持たない(この設定は端末の見方)── 当てた側がボタンの見た目も揃える
  for (const b of root.ownerDocument.querySelectorAll<HTMLButtonElement>(`button[data-pkc-action="${TOGGLE_PRINT_LAYOUT_ACTION}"]`))
    paintPrintLayoutButton(b, on);
}

/** 印刷レイアウト表示の切替ボタンの `data-pkc-action`(情報ペイン・binder が同じ綴りを引く)。 */
export const TOGGLE_PRINT_LAYOUT_ACTION = 'toggle-print-layout';

/**
 * 切替ボタンの見た目を、いまの状態に合わせる(`aria-pressed` と字)。
 * ⚠ 値が変わらなければ書かない。字は「いまどちらの表示か」を言う(押すと反対側へ切り替わる)。
 */
export function paintPrintLayoutButton(b: HTMLButtonElement, on: boolean): void {
  const pressed = on ? 'true' : 'false';
  if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
  const text = on ? '印刷レイアウト' : '通常表示';
  if (b.textContent !== text) b.textContent = text;
  const title = on
    ? '本文を印刷する1 枚の紙のように表示しています。押すと通常表示に戻ります'
    : '押すと、本文を印刷する紙の大きさ・余白で、1 枚の紙のように表示します(フル HD・4:3 などの画面用のページ設定では A4 縦を紙の基準にします)';
  if (b.title !== title) b.title = title;
}

/** user が選んだ ── 当てて**保存する**(切は鍵ごと消す)。開いているノートの紙の寸法も当て直す。 */
export function choosePrintLayout(root: HTMLElement, on: boolean): void {
  applyPrintLayout(root, on);
  try {
    if (on) store()?.setItem(PRINT_LAYOUT_STORAGE_KEY, '1');
    else store()?.removeItem(PRINT_LAYOUT_STORAGE_KEY);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
  refreshNoteLayout();
}

/** 切り替える。@returns 切り替えた後の値 */
export function togglePrintLayout(root: HTMLElement): boolean {
  const next = !isPrintLayoutOn(root);
  choosePrintLayout(root, next);
  return next;
}

/** 別のウィンドウで切り替えた値を、開いたままの自分にも当てる。返り値で外す。 */
export function watchPrintLayoutFromOtherWindows(
  root: HTMLElement,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  // 🔑 アプリの紙面・段数・字体が別のウィンドウで変わったときも、開いているノートの有効な値(紙の寸法・`@page`)を当て直す
  const follows = new Set([PRINT_LAYOUT_STORAGE_KEY, PAGE_FORMAT_STORAGE_KEY, READ_COLUMNS_STORAGE_KEY, FONT_STORAGE_KEY]);
  const onStorage = (ev: Event): void => {
    const key = (ev as StorageEvent).key;
    if (key !== null && !follows.has(key)) return;
    if (key === null || key === PRINT_LAYOUT_STORAGE_KEY) applyPrintLayout(root, initialPrintLayout());
    refreshNoteLayout();
  };
  win.addEventListener('storage', onStorage);
  return () => win.removeEventListener('storage', onStorage);
}

/**
 * 🔴 **中央に出ているノートの本文のうち、ページ設定の対象になるもの**(無ければ `null`)。
 * 選んでいるノートの本文が届いていて、user 領域の文書(フォルダ・system 領域以外 ── `noteLayoutApplies`)のときだけ。
 * ⚠ 編集中も同じ本文(`openBody`)を見る ── 前書きを打ち直せば、その場で反映される。
 */
export function noteLayoutBodyOf(state: AppState): string | null {
  const lid = state.selectedLid;
  if (lid === null) return null;
  const open = state.openBody;
  if (open === null || open === undefined || open.lid !== lid) return null;
  const meta = state.entryMetas.get(lid);
  if (meta === undefined || !noteLayoutApplies(lid, meta.archetype)) return null;
  return open.body;
}

/** 器の属性を、変わるときだけ書く / 外す。 */
function putAttr(el: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/** 器の CSS 変数を、変わるときだけ書く / 外す。 */
function putVar(el: HTMLElement, name: string, value: string | null): void {
  const cur = el.style.getPropertyValue(name);
  if (value === null) {
    if (cur !== '') el.style.removeProperty(name);
  } else if (cur !== value) el.style.setProperty(name, value);
}

/** 最後に当てた器・本文(印刷レイアウト表示の切替やアプリの設定の変更で当て直すため)。 */
let lastPane: HTMLElement | null = null;
let lastBody: string | null = null;
/** 本文 → 読んだページ設定の控え(同じ本文を描き直すたびに前書きを解析しない)。 */
let parsedBody: string | null = null;
let parsedSpec: NoteLayoutSpec = EMPTY_NOTE_LAYOUT;

function noteSpecOf(body: string | null): NoteLayoutSpec {
  if (body === null) return EMPTY_NOTE_LAYOUT;
  if (body !== parsedBody) {
    parsedBody = body;
    parsedSpec = readNoteLayout(body);
  }
  return parsedSpec;
}

/** いまのアプリの設定(`<html>` の印が正本)。 */
function appSettings(root: HTMLElement): { pageFormat: ReturnType<typeof currentPageFormat>; readColumns: ReadColumns; font: ReturnType<typeof currentFont> } {
  return { pageFormat: currentPageFormat(root), readColumns: currentReadColumns(root), font: currentFont(root) };
}

/**
 * 🔴 **開いているノートのページ設定を器へ当てる**(`DetailRenderer.render` が主の枠で毎回呼ぶ)。
 *
 * @param pane 中央の本文の器(`[data-pkc-view-pane="detail"]`)
 * @param body いま中央に出ているノートの本文(ページ設定の対象でない・ノートが出ていないなら `null`)
 * @returns 当てた有効な値(test 用)
 */
export function syncNoteLayout(pane: HTMLElement, body: string | null, doc: Document = pane.ownerDocument): EffectiveLayout {
  // 🔴 前に当てた器が別物なら、そちらの上書きを外してから当てる(作り直された器に古い上書きを残さない)
  if (lastPane !== null && lastPane !== pane) clearNoteLayout(lastPane);
  lastPane = pane;
  lastBody = body;
  const root = doc.documentElement;
  const note = noteSpecOf(body);
  const app = appSettings(root);
  const eff = resolveEffectiveLayout(note, app);
  // 紙面(読み幅)── 値は `PAGE_FORMATS` の表から引く(CSS に写さない)
  putAttr(pane, PAGE_FORMAT_ATTR, note.pageFormat);
  putVar(pane, '--read-w', note.pageFormat === null ? null : pageFormatSpec(note.pageFormat).readWidth);
  // 字体 ── `FONTS` の表から引く
  putAttr(pane, NOTE_FONT_ATTR, note.pageFont);
  putVar(pane, '--font', note.pageFont === null ? null : fontSpec(note.pageFont).ui);
  // 段組み ── `READ_COLUMN_CHOICES` の表から引く(`app.css` の `columns` は `--pkc-read-cols` を読む)
  putAttr(pane, NOTE_COLUMNS_ATTR, note.pageColumns);
  putVar(pane, READ_COLUMNS_VAR, note.pageColumns === null ? null : String(readColumnsSpec(note.pageColumns).count));
  // 印刷レイアウト表示の紙の寸法(入のときだけ)
  const sheet = isPrintLayoutOn(root) && body !== null;
  const paper = paperSheetSpec(eff.pageFormat);
  const cols = readColumnsSpec(eff.readColumns).count;
  putVar(pane, PAPER_W_VAR, sheet ? paper.width : null);
  putVar(pane, PAPER_H_VAR, sheet ? paper.minHeight : null);
  putVar(pane, PAPER_PAD_VAR, sheet ? sheetPadding(eff.sheetMargin) : null);
  putAttr(pane, PAPER_FALLBACK_ATTR, sheet && paper.fallbackToA4 ? '' : null);
  putAttr(pane, SHEET_COLS_ATTR, sheet && cols >= 2 ? String(cols) : null);
  putVar(pane, SHEET_COLS_VAR, sheet && cols >= 2 ? String(cols) : null);
  // 🔴 `@page` ── ノートが出ているときはその有効な紙面 + 余白、出ていなければアプリの紙面(余白なし = 従来どおり)
  if (body === null) applyPaper(doc, app.pageFormat, null);
  else applyPaper(doc, eff.pageFormat, eff.pageMargin);
  return eff;
}

/** 器からノートの上書きを全部外す(ノートを閉じた・別の画面へ移った・器が作り直された)。 */
export function clearNoteLayout(pane: HTMLElement): void {
  for (const a of [PAGE_FORMAT_ATTR, NOTE_FONT_ATTR, NOTE_COLUMNS_ATTR, PAPER_FALLBACK_ATTR, SHEET_COLS_ATTR]) putAttr(pane, a, null);
  for (const v of ['--read-w', '--font', READ_COLUMNS_VAR, PAPER_W_VAR, PAPER_H_VAR, PAPER_PAD_VAR, SHEET_COLS_VAR]) putVar(pane, v, null);
}

/**
 * 最後に当てた器へ当て直す(印刷レイアウト表示の切替・アプリの設定の変更のあと)。
 * ⚠ 器が外れていれば何もしない(次の描画が当てる)。
 */
export function refreshNoteLayout(): void {
  if (lastPane === null || !lastPane.isConnected) return;
  syncNoteLayout(lastPane, lastBody);
}

/** ⚠ test 用 ── 控えを忘れる。 */
export function resetNoteLayoutForTest(): void {
  lastPane = null;
  lastBody = null;
  parsedBody = null;
  parsedSpec = EMPTY_NOTE_LAYOUT;
}
