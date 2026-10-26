/**
 * 🔴 **テキスト整形の面**(#1233。user 指示 2026-10-26「全部やるのです」)。
 *
 * ## どこに在るか ── 別ウィンドウ(アプリの一覧のタイル)だけ
 *
 * 左の列に同じ面は置かない。理由: 貼り付けた文章を整える間、左の列の一覧も本文も
 * 動かさずに済む「道具」であって、ノートの見方ではない(SQL で調べると同じ判断。
 * 左のタブを足すと、広い画面でも既存のタブが「⋯」へ畳まれるため)。ブラウザが別ウィンドウを
 * 塞いだときは、本文を消さないよう**聞いてから**中央で開く(`view-window.ts` の `fallback`)。
 *
 * ## 構え
 *
 * 左に貼る → 整え方を選ぶ → 右に結果が出る(打つそばから)。規則は `features/markdown/text-lab.ts`
 * の 1 本で、この file は**画面の部品と、DOM から入力を読み結果を書く口**だけを持つ。
 * 入力は書き換えない。結果は「コピー」「新しいノートにする」「このノートの本文を置き換える」で外へ出す。
 *
 * ⚠ **「本文を置き換える」は、読み込んだノートが変わっていないときだけ**効く
 *   (読み込んだ時点の本文を控えておき、いまの本文と食い違えば断る)。置き換えたあとも
 *   履歴に前の版が 1 つ残るので、ノートの履歴から戻せる(`REIMPORT_BODY`)。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  LAB_OPS,
  LAB_TABLE_MODES,
  labSummary,
  runTextLab,
  type LabOp,
  type LabOutput,
  type LabRecipe,
  type LabTableMode,
} from '@features/markdown/text-lab';

/** 画面の部品を引く属性。⚠ 綴りはここ 1 か所(binder は import する)。 */
export const LAB_OP_ATTR = 'data-pkc-lab-op';
export const LAB_TABLE_ATTR = 'data-pkc-lab-table';

/** 読み込んだノート(「本文を置き換える」の相手)。⚠ DOM に本文を持たせず、面ごとに控える。 */
const LOADED = new WeakMap<HTMLElement, { lid: string; body: string }>();

export function setLabLoaded(pane: HTMLElement, lid: string, body: string): void {
  LOADED.set(pane, { lid, body });
}
export function labLoaded(pane: HTMLElement): { lid: string; body: string } | null {
  return LOADED.get(pane) ?? null;
}

function field<T extends HTMLElement>(pane: HTMLElement, name: string): T | null {
  return pane.querySelector<T>(`[data-pkc-field="${name}"]`);
}

/** 画面の選びから、整え方を組む。 */
export function readLabRecipe(pane: HTMLElement): LabRecipe {
  const ops: LabOp[] = [];
  for (const b of pane.querySelectorAll<HTMLElement>(`[${LAB_OP_ATTR}][aria-pressed="true"]`)) {
    ops.push(b.getAttribute(LAB_OP_ATTR) as LabOp);
  }
  const table =
    (pane
      .querySelector<HTMLElement>(`[${LAB_TABLE_ATTR}][aria-pressed="true"]`)
      ?.getAttribute(LAB_TABLE_ATTR) as LabTableMode | undefined) ?? 'none';
  const pattern = field<HTMLInputElement>(pane, 'textlab-pattern')?.value ?? '';
  const replacement = field<HTMLInputElement>(pane, 'textlab-replacement')?.value ?? '';
  const flags = field<HTMLInputElement>(pane, 'textlab-flags')?.value.trim() ?? '';
  return { ops, table, regex: pattern === '' ? null : { pattern, replacement, flags } };
}

export function readLabInput(pane: HTMLElement): string {
  return field<HTMLTextAreaElement>(pane, 'textlab-input')?.value ?? '';
}

/** いまの結果(画面の右の欄の字ではなく、入力から組み直す ── 欄に触れても結果が変わらない)。 */
export function currentLabOutput(pane: HTMLElement): { input: string; recipe: LabRecipe; out: LabOutput } {
  const input = readLabInput(pane);
  const recipe = readLabRecipe(pane);
  return { input, recipe, out: runTextLab(input, recipe) };
}

/** 結果と一言を描き直す。⚠ 入力の欄には触れない(打ちかけの caret を飛ばさない)。 */
export function refreshTextLab(pane: HTMLElement): void {
  const { input, recipe, out } = currentLabOutput(pane);
  const output = field<HTMLTextAreaElement>(pane, 'textlab-output');
  if (output !== null && output.value !== out.text) output.value = out.text;
  const summary = field<HTMLElement>(pane, 'textlab-summary');
  if (summary !== null) summary.textContent = labSummary(input, out, recipe);
  const empty = out.text === '';
  for (const name of ['textlab-copy', 'textlab-to-note']) {
    const b = field<HTMLButtonElement>(pane, name);
    if (b !== null) b.disabled = empty;
  }
}

/** 「読み込む」「置き換える」の押せる・押せないを、いまの state から決める。 */
export function syncTextLabButtons(pane: HTMLElement, state: AppState): void {
  const load = field<HTMLButtonElement>(pane, 'textlab-load-note');
  if (load !== null) {
    const ready = state.selectedLid !== null && state.openBody?.lid === state.selectedLid;
    load.disabled = !ready;
    load.title = ready
      ? '開いているノートの本文を、左の欄に読み込みます(欄に打った字は置き換わります)'
      : '先に、左の一覧でノートを開いてください';
  }
  const apply = field<HTMLButtonElement>(pane, 'textlab-apply-note');
  if (apply !== null) {
    const loaded = labLoaded(pane);
    const same = loaded !== null && loaded.lid === state.selectedLid;
    apply.disabled = !same || refreshEmpty(pane);
    apply.title = same
      ? '結果で、読み込んだノートの本文を置き換えます(前の版はノートの履歴に残ります)'
      : '「開いているノートを読み込む」を押したノートが開いているときに使えます';
  }
}

function refreshEmpty(pane: HTMLElement): boolean {
  return (field<HTMLTextAreaElement>(pane, 'textlab-output')?.value ?? '') === '';
}

export class TextLabRenderer {
  private readonly host: HTMLElement;
  private built = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  render(state: AppState): void {
    if (!this.built) this.build();
    syncTextLabButtons(this.host, state);
  }

  private build(): void {
    this.built = true;
    const h = this.host;
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = 'テキスト整形';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'textlab-note');
    note.textContent =
      '左に文章を貼り、整え方を選ぶと、右に結果が出ます。左の文章は書き換わりません。選んだ整え方は、決まった順で重ねて掛かります。';

    const opsRow = document.createElement('div');
    opsRow.setAttribute('data-pkc-field', 'textlab-ops');
    opsRow.setAttribute('role', 'group');
    opsRow.setAttribute('aria-label', '整え方');
    for (const op of LAB_OPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'textlab-toggle');
      b.setAttribute(LAB_OP_ATTR, op.id);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = op.label;
      b.title = op.hint;
      opsRow.append(b);
    }

    const tableRow = document.createElement('div');
    tableRow.setAttribute('data-pkc-field', 'textlab-tables');
    tableRow.setAttribute('role', 'group');
    tableRow.setAttribute('aria-label', '表の変換');
    for (const t of LAB_TABLE_MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'textlab-table');
      b.setAttribute(LAB_TABLE_ATTR, t.id);
      b.setAttribute('aria-pressed', t.id === 'none' ? 'true' : 'false');
      b.textContent = t.label;
      b.title = t.hint;
      tableRow.append(b);
    }

    const regexRow = document.createElement('div');
    regexRow.setAttribute('data-pkc-field', 'textlab-regex');
    const mk = (name: string, label: string, ph: string, value = ''): HTMLLabelElement => {
      const lab = document.createElement('label');
      const cap = document.createElement('span');
      cap.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.value = value;
      inp.placeholder = ph;
      inp.setAttribute('data-pkc-field', name);
      lab.append(cap, inp);
      return lab;
    };
    regexRow.append(
      mk('textlab-pattern', '検索パターン(正規表現)', '例: \\s+$'),
      mk('textlab-replacement', '置換後の文字列', '例: $1(空なら消します)'),
      mk('textlab-flags', '旗', 'g', 'g'),
    );

    const input = document.createElement('textarea');
    input.setAttribute('data-pkc-field', 'textlab-input');
    input.setAttribute('aria-label', '整える文章');
    input.placeholder = 'ここに文章を貼ります';
    input.spellcheck = false;
    const inButtons = document.createElement('div');
    inButtons.setAttribute('data-pkc-field', 'textlab-in-tools');
    const load = this.button('textlab-load-note', '開いているノートを読み込む', '');
    load.setAttribute('data-pkc-action', 'textlab-load-note');
    const clear = this.button('textlab-clear', '消す', '左の欄を空にします');
    clear.setAttribute('data-pkc-action', 'textlab-clear');
    inButtons.append(load, clear);
    const left = document.createElement('section');
    left.setAttribute('data-pkc-field', 'textlab-left');
    const lh = document.createElement('h3');
    lh.textContent = '元の文章';
    left.append(lh, input, inButtons);

    const output = document.createElement('textarea');
    output.setAttribute('data-pkc-field', 'textlab-output');
    output.setAttribute('aria-label', '整えた結果');
    output.readOnly = true;
    output.spellcheck = false;
    const summary = document.createElement('p');
    summary.setAttribute('data-pkc-field', 'textlab-summary');
    summary.setAttribute('role', 'status');
    const outButtons = document.createElement('div');
    outButtons.setAttribute('data-pkc-field', 'textlab-out-tools');
    const copy = this.button('textlab-copy', '結果をコピー', '右の結果を、クリップボードにコピーします');
    copy.setAttribute('data-pkc-action', 'textlab-copy');
    const toNote = this.button('textlab-to-note', '新しいノートにする', '結果を、新しいノートとして保存します');
    toNote.setAttribute('data-pkc-action', 'textlab-to-note');
    const apply = this.button('textlab-apply-note', 'このノートの本文を置き換える', '');
    apply.setAttribute('data-pkc-action', 'textlab-apply-note');
    outButtons.append(copy, toNote, apply);
    const right = document.createElement('section');
    right.setAttribute('data-pkc-field', 'textlab-right');
    const rh = document.createElement('h3');
    rh.textContent = '整えた結果';
    right.append(rh, output, summary, outButtons);

    const cols = document.createElement('div');
    cols.setAttribute('data-pkc-field', 'textlab-cols');
    cols.append(left, right);

    h.append(title, note, opsRow, tableRow, regexRow, cols);
    refreshTextLab(h);
  }

  /** ⚠ 口(`data-pkc-action`)は呼び側が**字で**付ける(変数で配ると出口の全数検査が追えない)。 */
  private button(field: string, label: string, hint: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (hint !== '') b.title = hint;
    b.setAttribute('data-pkc-field', field);
    return b;
  }
}
