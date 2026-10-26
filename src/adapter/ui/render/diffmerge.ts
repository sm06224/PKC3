/**
 * 🔴 **差分マージの面**(#1231。user 指示 2026-10-26「全部やるのです」)。
 *
 * ## どこに在るか ── 別ウィンドウ(アプリの一覧のタイル)だけ
 *
 * 左の列にタブは置かない: タブを足すと広い画面でも既存のタブが「⋯」へ畳まれる(#1900)。
 * この窓を閉じて失うのは取り込みの途中経過だけで、ノートは保存を押すまで 1 件も変わらない ── アプリで正しい。
 * ブラウザが別ウィンドウを塞いだときは、本文を消さないよう**聞いてから**中央で開く(`view-window.ts` の `fallback`)。
 *
 * ## 構え
 *
 * 左右に**相手**を選ぶ(ノートの本文 / ノートの履歴の版 / ノートとつながっている PC のファイル)。ちがいは左右に並び、
 * 塊ごとに「→ 左の内容を右へ」「← 右の内容を左へ」を押すと、その塊が両側とも同じ字になる(取り消せる)。
 * **字を書き換えられるのはノートの側だけ**(版は書き換えられず、PC のファイルは書き戻しの確認を通る別の道)。
 * 「変更を保存」を押すまで何も書かない。保存は既存の「本文を置き換える」(`REIMPORT_BODY`)を通るので、
 * 置き換え前の版はノートの履歴に残る。規則(塊・取り込み・取り消し)は `features/revision/merge-hunks.ts` の 1 本。
 *
 * この file は**画面の部品と、面が持つ状態(`DiffSession`)**だけを持つ。読み込み(store を呼ぶ)は binder が
 * `BinderServices` を通して行い、結果をここへ渡す(層規約: 描画器は store を呼ばない)。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  buildMergeSegs,
  countHunks,
  MergeSession,
  mergeRows,
  mergeText,
  MERGE_MAX_LINES,
  type MergeRow,
} from '@features/revision/merge-hunks';
import { diffLineEl, sideCellEl } from './diff-line';

/** 相手の種類。 */
export type DiffSourceKind = 'note' | 'rev' | 'file';
export type DiffSideName = 'left' | 'right';

export const DIFF_KIND_LABEL: Readonly<Record<DiffSourceKind, string>> = {
  note: 'ノートの本文',
  rev: 'ノートの履歴の版',
  file: 'ノートとつながっている PC のファイル',
};

export interface DiffRevOption {
  readonly id: string;
  readonly label: string;
}

export interface DiffSideState {
  kind: DiffSourceKind;
  lid: string | null;
  revId: string | null;
  /** 履歴の版の一覧(`kind === 'rev'` でノートを選んだ後)。`null` = まだ。 */
  revs: readonly DiffRevOption[] | null;
  load: 'empty' | 'loading' | 'loaded' | 'failed';
  /** 読み込んだ字。取り込みで変わる字はここではなく `MergeSession` が持つ。 */
  text: string | null;
  /** 読み込んだ時点の字(保存の突き合わせ用)。`kind === 'note'` のときだけ意味がある。 */
  baseline: string | null;
  /** 読めなかった理由・状況の一言。 */
  note: string;
  /** 読み込みの世代。古い読み込みの返事で画面を巻き戻さない。 */
  token: number;
}

export interface DiffSession {
  readonly left: DiffSideState;
  readonly right: DiffSideState;
  merge: MergeSession | null;
  /** 行数が多すぎて比べなかった。 */
  tooBig: boolean;
  showAll: boolean;
  /** 保存・取り込みの結果の一言(次の操作まで残す)。 */
  message: string;
}

function freshSide(): DiffSideState {
  return { kind: 'note', lid: null, revId: null, revs: null, load: 'empty', text: null, baseline: null, note: '', token: 0 };
}

const SESSIONS = new WeakMap<HTMLElement, DiffSession>();

export function diffSession(pane: HTMLElement): DiffSession {
  let s = SESSIONS.get(pane);
  if (s === undefined) {
    s = { left: freshSide(), right: freshSide(), merge: null, tooBig: false, showAll: false, message: '' };
    SESSIONS.set(pane, s);
  }
  return s;
}

export function diffSide(pane: HTMLElement, side: DiffSideName): DiffSideState {
  return diffSession(pane)[side];
}

/** 書き換えられる側か(ノートの本文だけ)。 */
export function isEditableSide(s: DiffSideState): boolean {
  return s.kind === 'note' && s.load === 'loaded' && s.lid !== null;
}

/** 両側が読めたら塊を作り直す。⚠ 読み込みや相手の選び直しのたびに呼ぶ(取り込みの途中経過は捨てる)。 */
export function rebuildMerge(pane: HTMLElement): void {
  const s = diffSession(pane);
  s.merge = null;
  s.tooBig = false;
  if (s.left.load !== 'loaded' || s.right.load !== 'loaded') return;
  const segs = buildMergeSegs(s.left.text ?? '', s.right.text ?? '');
  if (segs === null) s.tooBig = true;
  else s.merge = new MergeSession(segs);
}

/** いまの字(取り込み後)。読めていなければ `null`。 */
export function diffSideText(pane: HTMLElement, side: DiffSideName): string | null {
  const s = diffSession(pane);
  if (s.merge !== null) return mergeText(s.merge.segs, side === 'left' ? 'a' : 'b');
  return s[side].load === 'loaded' ? s[side].text : null;
}

/** 保存の対象になる側(ノートで、読み込んだ時点から字が変わっている)。 */
export function dirtySides(pane: HTMLElement): { side: DiffSideName; lid: string; text: string; baseline: string }[] {
  const s = diffSession(pane);
  const out: { side: DiffSideName; lid: string; text: string; baseline: string }[] = [];
  for (const side of ['left', 'right'] as const) {
    const st = s[side];
    if (!isEditableSide(st) || st.baseline === null) continue;
    const text = diffSideText(pane, side);
    if (text !== null && text !== st.baseline) out.push({ side, lid: st.lid!, text, baseline: st.baseline });
  }
  return out;
}

/** 表に並べる行の上限(対の数)。⚠ 超えた分は出さず、理由を言う。 */
export const DIFF_ROWS_MAX = 4000;

function field<T extends HTMLElement>(pane: HTMLElement, name: string): T | null {
  return pane.querySelector<T>(`[data-pkc-field="${name}"]`);
}

function sideEl(pane: HTMLElement, side: DiffSideName): HTMLElement | null {
  return pane.querySelector<HTMLElement>(`[data-pkc-field="diff-side"][data-pkc-side="${side}"]`);
}

/** 選べるノートの一覧を state から作る(ノートの本文 / 版の相手)。添付とフォルダは本文を比べる相手にならない。 */
function noteOptions(state: AppState): { lid: string; title: string }[] {
  const out: { lid: string; title: string }[] = [];
  for (const lid of state.order) {
    const m = state.entryMetas.get(lid);
    if (m === undefined || m.archetype === 'attachment' || m.archetype === 'folder') continue;
    out.push({ lid, title: m.title === '' ? '(無題)' : m.title });
  }
  return out;
}

/** つながっている PC のファイルを持つノート。 */
function linkedOptions(state: AppState): { lid: string; title: string }[] {
  return noteOptions(state)
    .filter((o) => state.linkedFiles.has(o.lid))
    .map((o) => ({ ...o, title: `${o.title}(${state.linkedFiles.get(o.lid)!})` }));
}

const OPTION_PRINT = new WeakMap<HTMLElement, string>();

/** 選び所の中身を state に合わせる。⚠ 一覧が変わったときだけ作り直す(打ちかけの選びを飛ばさない)。 */
export function syncDiffOptions(pane: HTMLElement, state: AppState): void {
  const notes = noteOptions(state);
  const linked = linkedOptions(state);
  const print = `${notes.length}|${notes.map((n) => n.lid + n.title).join('\u0001')}|${linked.map((n) => n.lid + n.title).join('\u0001')}`;
  if (OPTION_PRINT.get(pane) === print) return;
  OPTION_PRINT.set(pane, print);
  const s = diffSession(pane);
  for (const side of ['left', 'right'] as const) {
    const el = sideEl(pane, side);
    const select = el?.querySelector<HTMLSelectElement>('[data-pkc-pick="note"]');
    if (select === undefined || select === null) continue;
    const st = s[side];
    const list = st.kind === 'file' ? linked : notes;
    select.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length === 0 && st.kind === 'file' ? '(PC のファイルとつながっているノートがありません)' : '(ノートを選んでください)';
    select.append(blank);
    for (const o of list) {
      const opt = document.createElement('option');
      opt.value = o.lid;
      opt.textContent = o.title;
      select.append(opt);
    }
    select.value = st.lid ?? '';
  }
}

/** 種類を変えたときの選び所の作り直し用に、最後の state を覚えておく。 */
const LAST_STATE = new WeakMap<HTMLElement, AppState>();

/** 左右の選び所と状況の一言を、`DiffSession` に合わせる。 */
export function paintDiffSides(pane: HTMLElement): void {
  const s = diffSession(pane);
  const state = LAST_STATE.get(pane) ?? null;
  for (const side of ['left', 'right'] as const) {
    const el = sideEl(pane, side);
    if (el === null) continue;
    const st = s[side];
    const kind = el.querySelector<HTMLSelectElement>('[data-pkc-pick="kind"]');
    if (kind !== null && kind.value !== st.kind) kind.value = st.kind;
    const note = el.querySelector<HTMLSelectElement>('[data-pkc-pick="note"]');
    if (note !== null && state !== null) {
      // 種類で一覧が違う(ファイルはつながっているノートだけ)── 一覧の元になる種類が変わったら作り直す
      const wantLinked = st.kind === 'file';
      if (note.getAttribute('data-pkc-linked') !== (wantLinked ? '1' : '0')) {
        note.setAttribute('data-pkc-linked', wantLinked ? '1' : '0');
        OPTION_PRINT.delete(pane);
        syncDiffOptions(pane, state);
      }
      if (note.value !== (st.lid ?? '')) note.value = st.lid ?? '';
    }
    const rev = el.querySelector<HTMLSelectElement>('[data-pkc-pick="rev"]');
    if (rev !== null) {
      rev.hidden = st.kind !== 'rev';
      if (st.kind === 'rev') {
        const key = `${st.lid ?? ''}|${st.revs === null ? 'null' : st.revs.map((r) => r.id).join(',')}`;
        if (rev.getAttribute('data-pkc-print') !== key) {
          rev.setAttribute('data-pkc-print', key);
          rev.textContent = '';
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent =
            st.lid === null
              ? '(先にノートを選んでください)'
              : st.revs === null
                ? '(版の一覧を読んでいます…)'
                : st.revs.length === 0
                  ? '(このノートに履歴はありません)'
                  : '(版を選んでください)';
          rev.append(blank);
          for (const r of st.revs ?? []) {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            rev.append(opt);
          }
        }
        if (rev.value !== (st.revId ?? '')) rev.value = st.revId ?? '';
      }
    }
    const say = el.querySelector<HTMLElement>('[data-pkc-field="diff-side-note"]');
    if (say !== null) {
      say.textContent =
        st.load === 'loading'
          ? '読み込んでいます…'
          : st.load === 'failed'
            ? st.note
            : st.load === 'loaded'
              ? isEditableSide(st)
                ? '読み込みました(書き換えられる側です)'
                : '読み込みました(読むだけの側です。書き換えるのはノートの側)'
              : st.note;
    }
  }
}

function pairCount(rows: readonly MergeRow[]): number {
  return rows.reduce((n, r) => n + (r.kind === 'change' ? r.pairs.length : 1), 0);
}

/** ちがいの表と、上の一言・ボタンの押せる状態を描き直す。 */
export function paintDiffBody(pane: HTMLElement): void {
  const s = diffSession(pane);
  const body = field<HTMLElement>(pane, 'diff-body');
  const summary = field<HTMLElement>(pane, 'diff-summary');
  if (body === null || summary === null) return;
  body.textContent = '';
  const leftEdit = isEditableSide(s.left);
  const rightEdit = isEditableSide(s.right);
  const m = s.merge;
  let text: string;
  if (s.tooBig) {
    text = `行が多すぎるため(${MERGE_MAX_LINES.toLocaleString('ja-JP')} 行まで)、見比べられません`;
  } else if (m === null) {
    text =
      s.left.load === 'failed' || s.right.load === 'failed'
        ? '読み込めなかった相手があります。選び直してください'
        : '左右に相手を選ぶと、ちがいが出ます';
  } else {
    const n = countHunks(m.segs);
    text = n === 0 ? '左右は同じ内容です' : `ちがい ${n} か所`;
    if (n > 0 && !leftEdit && !rightEdit) text += '(どちらも読むだけの相手なので、取り込めません。ノートを選ぶと取り込めます)';
  }
  if (s.message !== '') text = `${text} / ${s.message}`;
  summary.textContent = text;

  if (m !== null) {
    const rows = mergeRows(m.segs, s.showAll);
    const cap = pairCount(rows) > DIFF_ROWS_MAX;
    let used = 0;
    let list: HTMLUListElement | null = null;
    const newList = (): HTMLUListElement => {
      const ul = document.createElement('ul');
      ul.setAttribute('data-pkc-diff-layout', 'side');
      body.append(ul);
      return ul;
    };
    for (const row of rows) {
      if (cap && used >= DIFF_ROWS_MAX) break;
      if (row.kind === 'change') {
        const hunk = document.createElement('div');
        hunk.setAttribute('data-pkc-field', 'diff-hunk');
        hunk.setAttribute('data-pkc-hunk', String(row.hunk));
        const bar = document.createElement('div');
        bar.setAttribute('data-pkc-field', 'diff-hunk-bar');
        const label = document.createElement('span');
        label.textContent = `ちがい ${row.hunk + 1}`;
        const toRight = document.createElement('button');
        toRight.type = 'button';
        toRight.setAttribute('data-pkc-action', 'diff-take');
        toRight.setAttribute('data-pkc-from', 'a');
        toRight.setAttribute('data-pkc-hunk', String(row.hunk));
        toRight.textContent = '→ 左の内容を右へ';
        toRight.disabled = !rightEdit;
        toRight.title = rightEdit ? 'この部分を、左の内容にそろえます(右のノートが変わります。保存を押すまで書きません)' : '右は読むだけの相手なので、取り込めません';
        const toLeft = document.createElement('button');
        toLeft.type = 'button';
        toLeft.setAttribute('data-pkc-action', 'diff-take');
        toLeft.setAttribute('data-pkc-from', 'b');
        toLeft.setAttribute('data-pkc-hunk', String(row.hunk));
        toLeft.textContent = '← 右の内容を左へ';
        toLeft.disabled = !leftEdit;
        toLeft.title = leftEdit ? 'この部分を、右の内容にそろえます(左のノートが変わります。保存を押すまで書きません)' : '左は読むだけの相手なので、取り込めません';
        bar.append(label, toLeft, toRight);
        const ul = document.createElement('ul');
        ul.setAttribute('data-pkc-diff-layout', 'side');
        for (const p of row.pairs) ul.append(sideCellEl('left', p.left), sideCellEl('right', p.right));
        hunk.append(bar, ul);
        body.append(hunk);
        list = null;
        used += row.pairs.length;
      } else if (row.kind === 'gap') {
        list = newList();
        list.append(diffLineEl({ kind: 'gap', text: '', skipped: row.skipped }));
        list = null;
        used += 1;
      } else {
        list ??= newList();
        const cell = { kind: 'same' as const, text: row.text, parts: null };
        list.append(sideCellEl('left', cell), sideCellEl('right', { ...cell }));
        used += 1;
      }
    }
    if (cap) {
      const more = document.createElement('p');
      more.setAttribute('data-pkc-field', 'diff-more');
      more.textContent = `${DIFF_ROWS_MAX.toLocaleString('ja-JP')} 行までを表示しています(残りも取り込みの対象です。「同じ行も全部出す」を切ると短くなります)`;
      body.append(more);
    }
  }

  const set = (name: string, disabled: boolean): void => {
    const b = field<HTMLButtonElement>(pane, name);
    if (b !== null) b.disabled = disabled;
  };
  const hunks = m === null ? 0 : countHunks(m.segs);
  set('diff-undo', m === null || !m.canUndo);
  set('diff-redo', m === null || !m.canRedo);
  set('diff-reset', m === null || !m.canUndo);
  set('diff-take-all-right', m === null || hunks === 0 || !rightEdit);
  set('diff-take-all-left', m === null || hunks === 0 || !leftEdit);
  set('diff-save', dirtySides(pane).length === 0);
  const toggle = field<HTMLElement>(pane, 'diff-toggle-all');
  if (toggle !== null) toggle.setAttribute('aria-pressed', s.showAll ? 'true' : 'false');
}

/** 一言を置く(次の操作まで残す)。 */
export function sayDiff(pane: HTMLElement, text: string): void {
  diffSession(pane).message = text;
  paintDiffBody(pane);
}

export class DiffMergeRenderer {
  private readonly host: HTMLElement;
  private built = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  render(state: AppState): void {
    if (!this.built) this.build();
    LAST_STATE.set(this.host, state);
    syncDiffOptions(this.host, state);
    // 「開いているノート」ボタンの押せる状態
    for (const side of ['left', 'right'] as const) {
      const b = sideEl(this.host, side)?.querySelector<HTMLButtonElement>('[data-pkc-field="diff-use-open"]');
      if (b !== undefined && b !== null) {
        b.disabled = state.selectedLid === null || !state.entryMetas.has(state.selectedLid);
        b.title = b.disabled ? '先に、左の一覧でノートを開いてください' : '開いているノートを、この側の相手にします';
      }
    }
    paintDiffSides(this.host);
  }

  private build(): void {
    this.built = true;
    const h = this.host;
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '差分マージ';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'diff-note');
    note.textContent =
      '左右に相手を選ぶと、ちがいが並びます。ちがいの 1 か所ずつ「→」「←」でどちらかの内容にそろえ、「変更を保存」を押すまで何も書きません。ノートの本文だけが書き換わる側で、履歴の版と PC のファイルは読むだけです。− は左にだけ、+ は右にだけある行です。';

    const sides = document.createElement('div');
    sides.setAttribute('data-pkc-field', 'diff-sides');
    for (const side of ['left', 'right'] as const) sides.append(this.buildSide(side));

    const tools = document.createElement('div');
    tools.setAttribute('data-pkc-field', 'diff-tools');
    const mk = (field: string, label: string, hint: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-field', field);
      b.textContent = label;
      b.title = hint;
      return b;
    };
    const undo = mk('diff-undo', '取り込みを元に戻す', '直前の取り込みを取り消します');
    undo.setAttribute('data-pkc-action', 'diff-undo');
    const redo = mk('diff-redo', 'やり直す', '取り消した取り込みをやり直します');
    redo.setAttribute('data-pkc-action', 'diff-redo');
    const reset = mk('diff-reset', '読み込んだ状態に戻す', '取り込みを全部取り消して、読み込んだ直後に戻します');
    reset.setAttribute('data-pkc-action', 'diff-reset');
    const allRight = mk('diff-take-all-right', '残りを全部、左の内容にそろえる', '残っているちがいの全部を、左の内容にそろえます(右のノートが変わります)');
    allRight.setAttribute('data-pkc-action', 'diff-take-all');
    allRight.setAttribute('data-pkc-from', 'a');
    const allLeft = mk('diff-take-all-left', '残りを全部、右の内容にそろえる', '残っているちがいの全部を、右の内容にそろえます(左のノートが変わります)');
    allLeft.setAttribute('data-pkc-action', 'diff-take-all');
    allLeft.setAttribute('data-pkc-from', 'b');
    const toggle = mk('diff-toggle-all', '同じ行も全部出す', '変わっていない行も省かずに並べます');
    toggle.setAttribute('data-pkc-action', 'diff-toggle-all');
    toggle.setAttribute('aria-pressed', 'false');
    const save = mk('diff-save', '変更を保存', '書き換わったノートを保存します(置き換え前の版はノートの履歴に残ります)');
    save.setAttribute('data-pkc-action', 'diff-save');
    save.disabled = true;
    tools.append(undo, redo, reset, allRight, allLeft, toggle, save);

    const summary = document.createElement('p');
    summary.setAttribute('data-pkc-field', 'diff-summary');
    summary.setAttribute('role', 'status');
    const cols = document.createElement('div');
    cols.setAttribute('data-pkc-field', 'diff-cols');
    const l = document.createElement('span');
    l.textContent = '左';
    const r = document.createElement('span');
    r.textContent = '右';
    cols.append(l, r);
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'diff-body');

    h.append(title, note, sides, tools, summary, cols, body);
    paintDiffBody(h);
  }

  private buildSide(side: DiffSideName): HTMLElement {
    const box = document.createElement('section');
    box.setAttribute('data-pkc-field', 'diff-side');
    box.setAttribute('data-pkc-side', side);
    const cap = document.createElement('h3');
    cap.textContent = side === 'left' ? '左' : '右';
    const kind = document.createElement('select');
    kind.setAttribute('data-pkc-action', 'diff-pick');
    kind.setAttribute('data-pkc-pick', 'kind');
    kind.setAttribute('data-pkc-side', side);
    kind.setAttribute('aria-label', `${cap.textContent}の相手の種類`);
    for (const k of ['note', 'rev', 'file'] as const) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = DIFF_KIND_LABEL[k];
      kind.append(o);
    }
    const note = document.createElement('select');
    note.setAttribute('data-pkc-action', 'diff-pick');
    note.setAttribute('data-pkc-pick', 'note');
    note.setAttribute('data-pkc-side', side);
    note.setAttribute('data-pkc-linked', '0');
    note.setAttribute('aria-label', `${cap.textContent}のノート`);
    const rev = document.createElement('select');
    rev.setAttribute('data-pkc-action', 'diff-pick');
    rev.setAttribute('data-pkc-pick', 'rev');
    rev.setAttribute('data-pkc-side', side);
    rev.setAttribute('aria-label', `${cap.textContent}の版`);
    rev.hidden = true;
    const useOpen = document.createElement('button');
    useOpen.type = 'button';
    useOpen.setAttribute('data-pkc-action', 'diff-use-open');
    useOpen.setAttribute('data-pkc-field', 'diff-use-open');
    useOpen.setAttribute('data-pkc-side', side);
    useOpen.textContent = '開いているノート';
    const say = document.createElement('p');
    say.setAttribute('data-pkc-field', 'diff-side-note');
    box.append(cap, kind, note, rev, useOpen, say);
    return box;
  }
}
