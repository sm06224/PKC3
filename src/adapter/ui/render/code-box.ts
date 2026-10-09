/**
 * 🔴 **コード枠だけをその場の入力欄にする**(#1044 段3)。
 *
 * ⚠ **`section-box.ts` と同じ作法**(§9「段2 の仕組みを共有する」)── 節点を動かさず、
 *   `data-pkc-source-line` で塊を 1 つだけ数えて差し替える。⚠ 章の欄は**複数の塊**
 *   (見出し配下の並び)を 1 つの箱へまとめるが、コード枠は**器そのものが 1 塊**
 *   (`.pkc-md-block[data-pkc-md-block-kind="code"]`)なので、範囲ではなく
 *   「その行 1 つ」を数える(2 つ目の走査規則ではなく、対象が違うだけ)。
 *
 * 🔑 **ここは pure DOM**(state も dispatch も知らない)── `section-box.ts` と同じ層。
 */
import { releaseGripIfTargeting } from './block-grip';
import { iconButton } from './icons';
import { limitDraftInput } from './read-columns';
import { sizeTextareaToContent } from './row-swap';

/** コード枠の箱の器(`data-pkc-region`)。⚠ test / smoke はここだけを見る。 */
export const CODE_BOX_REGION = 'code-draft';

/** 打つ欄の `data-pkc-field`。 */
export const CODE_BOX_INPUT_FIELD = 'code-draft-input';

/**
 * `host` の中で、コードの塊(`.pkc-md-block[data-pkc-md-block-kind="code"]`)のうち
 * `data-pkc-source-line` が `line` と一致するものを返す(#1044 段3 2巡目の修理、V2)。
 *
 * 🔴 **直下だけでは足りない**(直す前は `section-box.ts` の `blocksInRange` と同じ
 *   「直下だけ」だった)。⚠ **章の範囲(直下の並び)とコード枠(1 塊)は前提が違う** ──
 *   引用(`>`)の中の枠は `<blockquote>` の**孫**であり、しかも引用の中に地の文が
 *   あると `<blockquote>` 自身の `data-pkc-source-line` は**その地の文の行**(枠の
 *   開きの行ではない)を持つ。直下だけを見ると、①地の文が無い枠だけの引用では
 *   `<blockquote>` 自身が(たまたま同じ行番号を持つので)当たり、**引用ごと**消して
 *   箱を差し込んでいた(壊れてはいないが偶然)②地の文が 1 行でもあると**誰も
 *   当たらず**、reducer は開けているのに(`state.sectionDraft` は在る)箱は
 *   1 バイトも DOM に出ない ── 押しても無言(理由も出ない、いちばん静かな dead
 *   click)。
 * 🔑 **`data-pkc-md-block-kind="code"` で絞る** ── 中の `<pre><code>` も同じ
 *   `data-pkc-source-line` を持つが(`markdown-render.ts` の `sourceHtml`)、
 *   塊そのもの(外側の `div`)だけを掴む。
 */
function blockAtLine(host: HTMLElement, line: number): HTMLElement | null {
  for (const el of Array.from(
    host.querySelectorAll<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="code"]'),
  )) {
    const raw = el.getAttribute('data-pkc-source-line');
    if (raw === null) continue;
    if (Number(raw) === line) return el;
  }
  return null;
}

/**
 * コード枠の箱を差し込む(既にその行に箱が在れば何もしない ── 冪等)。
 *
 * @param line 剥がした本文の行番号(枠の開きの行。`section-box.ts` の `from` と同じ基準)
 * @param text 打つ欄の初期値(引用の前置き・開き・閉じの行を含まない、枠の中身)
 * @returns 差し込んだ `<textarea>`。⚠ **その行に塊が無ければ `null`**
 *   (本文が読めていない等の防波堤 ── 当てずっぽうで箱を出さない)
 */
export function installCodeBox(
  host: HTMLElement,
  opts: { readonly line: number; readonly text: string },
): HTMLTextAreaElement | null {
  const existing = host.querySelector<HTMLTextAreaElement>(
    `[data-pkc-field="${CODE_BOX_INPUT_FIELD}"]`,
  );
  if (existing !== null) return existing; // ⚠ 既に居るなら差し替えない(打ちかけを守る)
  const anchor = blockAtLine(host, opts.line);
  if (anchor === null) return null;
  const box = document.createElement('div');
  box.setAttribute('data-pkc-region', CODE_BOX_REGION);
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', CODE_BOX_INPUT_FIELD);
  ta.value = opts.text;
  const row = document.createElement('div');
  row.setAttribute('data-pkc-region', 'code-draft-buttons');
  const save = document.createElement('button');
  save.type = 'button';
  // 🔑 リテラルで書く(`action-outlets.mjs` が静的に追える形 ── section-box.ts と同じ)
  save.setAttribute('data-pkc-action', 'save-code-draft');
  save.textContent = 'コードを保存する';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-pkc-action', 'cancel-code-draft');
  cancel.textContent = 'コードの編集をやめる';
  /**
   * 🔴 **返ってこない保存の最後の出口**(#1044 段3。`section-box.ts` と同じ ── 追記の
   *   `writeLock` と共有する「打ち切る」ボタン)。押し所は保存中だけ見せる。
   */
  const release = iconButton('force-release', '書き込みを打ち切る');
  release.hidden = true;
  row.append(save, cancel, release);
  box.append(ta, row);
  anchor.before(box);
  releaseGripIfTargeting(host, [anchor]);
  anchor.remove();
  /**
   * 🔴 **高さは中身に合わせ、打つたびに育て直す**(#1044 段3。`section-box.ts` の
   *   F-F / R4 と同じ ── `row-swap.ts` の `sizeTextareaToContent` 1 本を共有する)。
   */
  sizeTextareaToContent(ta);
  ta.addEventListener('input', () => sizeTextareaToContent(ta));
  // 🔴 器の高さの上限(`--pkc-pane-h`)は箱に直に書く(#1467 段 3-c ── 器に書くと本文全体が再計算になる)
  limitDraftInput(ta);
  // 🔴 カーソルは先頭に置く(章と違い見出し行を持たないので、素直に中身の先頭)。
  ta.setSelectionRange(0, 0);
  ta.focus();
  box.scrollIntoView({ block: 'nearest' });
  return ta;
}

/**
 * 🔴 **保存中の見た目に切り替える**(#1044 段3。`section-box.ts` の
 *   `syncSectionBoxSaving` と同じ作法)。
 */
export function syncCodeBoxSaving(host: HTMLElement, saving: boolean): void {
  const box = host.querySelector<HTMLElement>(`[data-pkc-region="${CODE_BOX_REGION}"]`);
  if (box === null) return;
  const save = box.querySelector<HTMLButtonElement>('[data-pkc-action="save-code-draft"]');
  const cancel = box.querySelector<HTMLButtonElement>('[data-pkc-action="cancel-code-draft"]');
  const release = box.querySelector<HTMLButtonElement>('[data-pkc-action="force-release"]');
  if (save !== null) {
    save.disabled = saving;
    save.textContent = saving ? '保存しています…' : 'コードを保存する';
  }
  if (cancel !== null) cancel.disabled = saving;
  if (release !== null) release.hidden = !saving;
}

/**
 * いま出ているコード枠の箱の打ちかけの字。居なければ `null`。
 * ⚠ **保存 / 移動の判定に使う** ── state には打ちかけの字を持たない
 *   (`section-box.ts` の `sectionBoxText` と同じ規律)。
 */
export function codeBoxText(host: HTMLElement): string | null {
  return (
    host.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${CODE_BOX_INPUT_FIELD}"]`)?.value ??
    null
  );
}
