/**
 * 🔴 **計算スクラッチパッドの面**(#1230。user 指示 2026-10-26「全部やるのです」)。
 *
 * ## どこに在るか ── 別ウィンドウ(アプリの一覧のタイル)だけ
 *
 * 左の列にタブは置かない: タブを足すと広い画面でも既存のタブが「⋯」へ畳まれる(#1900)。
 * この窓を閉じて失うのは打った式だけで、ノートは 1 件も消えない ── アプリで正しい(SQL で調べると同じ判断)。
 * ブラウザが別ウィンドウを塞いだときは、本文を消さないよう**聞いてから**中央で開く(`view-window.ts` の `fallback`)。
 *
 * ## 構え
 *
 * 左に書く → 右に各行の結果が**同じ高さで**並ぶ。規則は `features/calc/sheet.ts` の 1 本。
 * 行の高さを揃えるため、左の欄は折り返さず(`wrap="off"`)、右の行は固定の高さで、2 つは同じ scroll 位置に連動する。
 * 打ちかけは `pkc3.calc-draft` に自動で覚え、次に開いたとき戻す(ノートにするのは user が押したとき)。
 */
import {
  evaluateSheet,
  SHEET_MAX_LINES,
  type SheetRow,
} from '@features/calc/sheet';
import { appCalcDraft, CALC_DRAFT_MAX_CHARS, type CalcDraftStore } from './calc-draft-store';

function field<T extends HTMLElement>(pane: HTMLElement, name: string): T | null {
  return pane.querySelector<T>(`[data-pkc-field="${name}"]`);
}

/** 左の欄の字。 */
export function readCalcText(pane: HTMLElement): string {
  return field<HTMLTextAreaElement>(pane, 'calc-input')?.value ?? '';
}

/** 今の評価結果(左の欄から組み直す)。 */
export function currentCalcRows(pane: HTMLElement): SheetRow[] {
  return evaluateSheet(readCalcText(pane));
}

/** 打ちかけの保存先。⚠ test が差し替えられるようにしておく。 */
let draft: CalcDraftStore = appCalcDraft;
export function setCalcDraftStoreForTest(store: CalcDraftStore): void {
  draft = store;
}

/** 保存を打鍵ごとにしない(連続する入力をまとめる)。 */
export const CALC_SAVE_DELAY_MS = 400;
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** 右の結果の列と一言を描き直す。⚠ 左の欄には触れない(打ちかけの caret を飛ばさない)。 */
export function refreshCalc(pane: HTMLElement, opts: { save?: boolean } = {}): void {
  const text = readCalcText(pane);
  const rows = evaluateSheet(text);
  const results = field<HTMLElement>(pane, 'calc-results');
  if (results !== null) {
    // 行の数が同じなら、字と印だけ差し替える(打つたびに節点を作り直さない)
    while (results.childElementCount > rows.length) results.lastElementChild?.remove();
    rows.forEach((r, i) => {
      let el = results.children[i] as HTMLElement | undefined;
      if (el === undefined) {
        el = document.createElement('div');
        results.append(el);
      }
      if (el.getAttribute('data-pkc-calc-row') !== r.kind) el.setAttribute('data-pkc-calc-row', r.kind);
      if (el.textContent !== r.display) el.textContent = r.display;
      // 名前の定義は、結果に名前を添える(押せない・読み上げ用)
      if (r.name === null) el.removeAttribute('title');
      else el.title = `名前: ${r.name}`;
    });
  }
  const lines = text === '' ? 0 : text.split('\n').length;
  const say = field<HTMLElement>(pane, 'calc-status');
  if (say !== null) {
    if (text.length > CALC_DRAFT_MAX_CHARS) {
      say.textContent = `保存できません: 長すぎます(${CALC_DRAFT_MAX_CHARS.toLocaleString('ja-JP')} 字まで)。このまま閉じると、前に覚えた内容に戻ります`;
    } else if (lines > SHEET_MAX_LINES) {
      say.textContent = `${SHEET_MAX_LINES.toLocaleString('ja-JP')} 行目までを計算しています`;
    } else if (say.hasAttribute('data-pkc-save-failed')) {
      // 🔴 保存に失敗した知らせは、次に保存できるまで残す(消すのは保存できたとき)
    } else if (say.hasAttribute('data-pkc-kept')) {
      // 「ノートにした」などの知らせは、次に打つまで残す
      if (opts.save === true) {
        say.removeAttribute('data-pkc-kept');
        say.textContent = '';
      }
    } else {
      say.textContent = '';
    }
  }
  const empty = rows.every((r) => r.kind === 'blank');
  for (const name of ['calc-to-table', 'calc-to-text', 'calc-copy']) {
    const b = field<HTMLButtonElement>(pane, name);
    if (b !== null) b.disabled = empty;
  }
  if (opts.save === true) {
    const prev = timers.get(pane);
    if (prev !== undefined) clearTimeout(prev);
    timers.set(
      pane,
      setTimeout(() => {
        timers.delete(pane);
        commitDraft(pane);
      }, CALC_SAVE_DELAY_MS),
    );
  }
}

/** いまの字を覚え、書けなかったら画面に言う(黙って失敗しない)。 */
function commitDraft(pane: HTMLElement): void {
  const result = draft.set(readCalcText(pane));
  const say = field<HTMLElement>(pane, 'calc-status');
  if (say === null) return;
  if (result === 'failed') {
    say.setAttribute('data-pkc-save-failed', '');
    say.textContent = '保存できませんでした(この端末の保存領域に書けません)。式はこの画面にだけあります。ノートにして残してください';
  } else if (say.hasAttribute('data-pkc-save-failed')) {
    say.removeAttribute('data-pkc-save-failed');
    say.textContent = '';
  }
}

/** 打ちかけを今すぐ覚える(窓を閉じる前・隠れる前・「消す」)。 */
export function flushCalcDraft(pane: HTMLElement): void {
  const prev = timers.get(pane);
  if (prev !== undefined) {
    clearTimeout(prev);
    timers.delete(pane);
  }
  commitDraft(pane);
}

/** 面の一言を置く(知らせは次に打つまで残す)。 */
export function sayCalc(pane: HTMLElement, text: string): void {
  const el = field<HTMLElement>(pane, 'calc-status');
  if (el === null) return;
  el.textContent = text;
  el.setAttribute('data-pkc-kept', '');
}

export class CalcRenderer {
  private readonly host: HTMLElement;
  private built = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  render(): void {
    if (this.built) return;
    this.built = true;
    const h = this.host;
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '計算スクラッチパッド';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'calc-note');
    note.textContent =
      '文章と式を混ぜて書くと、各行の右に結果が出ます。「名前 = 式」で名前を付けると、下の行で使えます(値を直すと下の結果も変わります)。単位(円・時間・個)は読み飛ばし、% は割合、「合計」だけの行は上の行を足します。打った式は自動で覚えます。';

    const tools = document.createElement('div');
    tools.setAttribute('data-pkc-field', 'calc-tools');
    const toTable = document.createElement('button');
    toTable.type = 'button';
    toTable.setAttribute('data-pkc-action', 'calc-to-table');
    toTable.setAttribute('data-pkc-field', 'calc-to-table');
    toTable.textContent = 'ノートにする(表)';
    toTable.title = '式と結果を Markdown の表にして、新しいノートに保存します';
    const toText = document.createElement('button');
    toText.type = 'button';
    toText.setAttribute('data-pkc-action', 'calc-to-text');
    toText.setAttribute('data-pkc-field', 'calc-to-text');
    toText.textContent = 'ノートにする(テキスト)';
    toText.title = '式の行の後ろに「→ 結果」を付けた文章にして、新しいノートに保存します';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.setAttribute('data-pkc-action', 'calc-copy');
    copy.setAttribute('data-pkc-field', 'calc-copy');
    copy.textContent = '結果をコピー';
    copy.title = '式と結果をテキストでクリップボードにコピーします';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.setAttribute('data-pkc-action', 'calc-clear');
    clear.setAttribute('data-pkc-field', 'calc-clear');
    clear.textContent = '消す';
    clear.title = '書いた式をすべて消します';
    tools.append(toTable, toText, copy, clear);

    const input = document.createElement('textarea');
    input.setAttribute('data-pkc-field', 'calc-input');
    input.setAttribute('aria-label', '計算の式');
    input.setAttribute('wrap', 'off');
    input.spellcheck = false;
    input.placeholder = '基本単価 = 3200 円\n作業時間 = 40 時間\n小計 = 基本単価 * 作業時間\n合計';
    input.value = draft.get();
    const results = document.createElement('div');
    results.setAttribute('data-pkc-field', 'calc-results');
    results.setAttribute('aria-label', '各行の結果');
    results.setAttribute('role', 'list');
    // 2 つの scroll を揃える(縦だけ。結果の列に scroll 帯は出さない)
    input.addEventListener('scroll', () => {
      results.scrollTop = input.scrollTop;
    });
    const sheet = document.createElement('div');
    sheet.setAttribute('data-pkc-field', 'calc-sheet');
    sheet.append(input, results);
    const status = document.createElement('p');
    status.setAttribute('data-pkc-field', 'calc-status');
    status.setAttribute('role', 'status');

    h.append(title, note, tools, sheet, status);
    refreshCalc(h);
    /**
     * 🔴 **窓を閉じる・隠れるときに、待っている保存を今すぐ済ませる**(レビュー ⚠7)。
     * ⚠ 保存は打鍵の 400ms 後なので、打った直後に閉じると最後の数文字が落ちる。`pagehide` は閉じる・移動、
     *   `visibilitychange`(隠れた)はスマホ・タブ切替で、閉じる合図が来ないことがあるため両方で拾う。
     */
    // ⚠ 画面から外れた面(別の面に替わった・作り直された)は触らない
    window.addEventListener('pagehide', () => {
      if (h.isConnected) flushCalcDraft(h);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && h.isConnected) flushCalcDraft(h);
    });
  }
}
