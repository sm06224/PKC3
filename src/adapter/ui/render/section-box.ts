/**
 * 🔴 **章だけをその場の入力欄にする**(#1044 段2)。
 *
 * ⚠ **節点を動かさない**(`heading-fold.ts` と同じ理由)── 見出しと配下を
 *   入れ子に組み替えると、塊の特定を「host の直下である」ことに頼っている
 *   `RowSwap` 等が壊れる(`heading-fold.ts` の docstring)。
 * 🔑 だから**塊を丸ごと 1 つの箱へ差し替える**:章に属する `host` の直下の塊を
 *   `data-pkc-source-line`(剥がした本文の行番号)で数え、まとめて 1 つの箱に
 *   置き換える。呼び側(`detail.ts`)が range(剥がした本文の行、`[from, to)`)を渡す。
 *
 * 🔑 **ここは pure DOM**(state も dispatch も知らない)── `cell-input.ts` と同じ層。
 */
import { releaseGripIfTargeting } from './block-grip';
import { iconButton } from './icons';
import { sizeTextareaToContent } from './row-swap';

/** 章の箱の器(`data-pkc-region`)。⚠ test / smoke はここだけを見る。 */
export const SECTION_BOX_REGION = 'section-draft';

/** 打つ欄の `data-pkc-field`。 */
export const SECTION_BOX_INPUT_FIELD = 'section-draft-input';

/**
 * `host` の直下で、`data-pkc-source-line` が `[from, to)`(剥がした本文の行番号)に
 * 収まる塊を、並び順のまま返す。
 *
 * ⚠ **直下だけ**(`host.children`)── 深く探ると、引用や `:::` の中の見出しの
 *   刻印まで拾い、章の外まで箱に取り込む。
 */
function blocksInRange(host: HTMLElement, from: number, to: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(host.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const raw = el.getAttribute('data-pkc-source-line');
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= from && n < to) out.push(el);
  }
  return out;
}

/**
 * 章の箱を差し込む(既にその範囲に箱が在れば何もしない ── 冪等)。
 *
 * @param from 剥がした本文の行番号(見出し自身の行。含む)
 * @param to 剥がした本文の行番号(次の見出し / 末尾。含まない)
 * @param text 打つ欄の初期値(見出し行を含む、章の原文)
 * @returns 差し込んだ `<textarea>`。⚠ **その範囲に塊が 1 つも無ければ `null`**
 *   (本文が読めていない等の防波堤 ── 当てずっぽうで箱を出さない)
 */
export function installSectionBox(
  host: HTMLElement,
  opts: { readonly from: number; readonly to: number; readonly text: string },
): HTMLTextAreaElement | null {
  const existing = host.querySelector<HTMLTextAreaElement>(
    `[data-pkc-field="${SECTION_BOX_INPUT_FIELD}"]`,
  );
  if (existing !== null) return existing; // ⚠ 既に居るなら差し替えない(打ちかけを守る)
  const blocks = blocksInRange(host, opts.from, opts.to);
  if (blocks.length === 0) return null;
  const anchor = blocks[0]!;
  const box = document.createElement('div');
  box.setAttribute('data-pkc-region', SECTION_BOX_REGION);
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', SECTION_BOX_INPUT_FIELD);
  ta.value = opts.text;
  const row = document.createElement('div');
  row.setAttribute('data-pkc-region', 'section-draft-buttons');
  const save = document.createElement('button');
  save.type = 'button';
  // 🔑 リテラルで書く(`action-outlets.mjs` が静的に追える形 ── 変数だと「③ 追えない」に落ちる)
  save.setAttribute('data-pkc-action', 'save-section-draft');
  save.textContent = '章を保存する';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.setAttribute('data-pkc-action', 'cancel-section-draft');
  cancel.textContent = '章の編集をやめる';
  /**
   * 🔴 **返ってこない保存の最後の出口**(#1044 段2 4巡目の修理、T1)。
   *
   * ⚠ **追記の `writeLock` と同じ「打ち切る」ボタン**(`iconButton('force-release', …)`)
   *   を再利用する ── 新しい見た目を作らない。⚠ 押し所は保存中だけ見せる
   *   (`syncSectionBoxSaving` が `hidden` を切る)── 二重押し・打ちかけの消失を防ぐため
   *   `save` / `cancel` は disable するが、それだけでは詰まったときの逃げ道が無い。
   */
  const release = iconButton('force-release', '書き込みを打ち切る');
  release.hidden = true;
  row.append(save, cancel, release);
  box.append(ta, row);
  anchor.before(box);
  /**
   * 🔴 **外す前に、掴む取っ手(⠿)がこの塊を指していないか確かめる**
   *   (#1044 段2 2巡目の修理、R9)。⚠ **これ自体は保険**(`block-grip.ts` の
   *   docstring参照)── 実ブラウザの smoke が拾った実害の本当の原因は
   *   `follow()` の `blockRange()` 側にあった(刻印の無い箱を「行 0 の塊」と
   *   誤認する別の穴。直した)。ここは、それとは別に**塊を外す側の責務**として
   *   正しい形にしておく(取っ手の再検証を次の描画まで待たない)。
   */
  releaseGripIfTargeting(host, blocks);
  for (const b of blocks) b.remove();
  /**
   * 🔴 **高さは中身に合わせる**(#1044 段2、F-F)。⚠ `row-swap.ts` の
   *   `sizeTextareaToContent` **1 本**を共有する(2 つ目の行数計算を作らない)。
   *   直す前は既定の `cols=20`(ブラウザ既定)のまま出ていたので、
   *   782px の読む幅に 173px の箱が出ていた(実測)。
   * 🔴 **打つたびに育て直す**(#1044 段2 2巡目の修理、R4)。⚠ F-F は開いた
   *   瞬間の 1 回だけ計算していた ── `row-swap.ts`(`RowSwap.syncActiveBox`)は
   *   `input` のたびに呼び直しているのに、章の欄はここが無かったので、
   *   打ち足すと箱が育たないまま見出しが箱の外へ隠れていた(いちばん見せたい
   *   見出し行が消える ── 上のカーソル配置の意図と逆の結果になる)。
   *   `RowSwap` の作法(打った後に数え直す)と同じ形にする ── 2 つ目の
   *   「いつ呼ぶか」の規則を作らない(§7)。
   */
  sizeTextareaToContent(ta);
  ta.addEventListener('input', () => sizeTextareaToContent(ta));
  /**
   * 🔴 **カーソルは見出し行の末尾に置く**(#1044 段2、F-F)。⚠ 直す前は
   *   本文の**末尾**に置いていたので、開いた瞬間に textarea が下まで
   *   scroll し、いちばん見せたい見出し行が箱の中で見えなくなっていた
   *   (`scrollTop` が 0 でなくなる)。見出し行(1 行目)の末尾に置けば、
   *   箱の先頭 = 見出しが常に見える。
   * 🔴 **`setSelectionRange` は `focus()` より先**(#1044 段2 2巡目の修理、
   *   R8。実ブラウザの smoke が拾った ── 上限超の章で `scrollTop` が 0 に
   *   ならず 170 だった)。⚠ 直す前は `focus()` → `setSelectionRange` の順
   *   だった ── 選択範囲が未設定のまま `<textarea>` に `focus()` すると、
   *   実ブラウザは**既定のカーソル位置**(値の末尾)へ先に scroll する。
   *   その直後に `setSelectionRange` で論理上の選択位置を見出し行の末尾へ
   *   動かしても、**scroll 位置は追随して戻らない**(happy-dom はこの
   *   scroll 挙動を再現しないので unit では見えない ── §4「happy-dom は
   *   layout を持たない」と同じ形)。先に選択位置を確定させてから `focus()`
   *   すれば、既定のカーソル移動そのものが起きない。
   */
  const headEnd = ta.value.indexOf('\n');
  const pos = headEnd === -1 ? ta.value.length : headEnd;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  // ⚠ 箱そのものが画面外(スクロール位置の外)なら、見える所まで動かす
  box.scrollIntoView({ block: 'nearest' });
  return ta;
}

/**
 * 🔴 **保存中の見た目に切り替える**(#1044 段2 3巡目の修理、S1)。
 *
 * ⚠ **打ちかけの字は 1 バイトも触らない** ── `installSectionBox` を呼び直すと
 *   `existing !== null` の防波堤で無視されるので安全だが、それとは別に
 *   `render()` の boxKey ガード(`detail.ts`)は「開いている間は他の理由でも
 *   描き直さない」ので、そもそもここは**箱を作り直さず、押し所だけ**触る。
 * 🔑 **追記の `writeLock` と同じ「二重押し・やめる・離れるを塞ぐ」目的**だが、
 *   追記の欄は押せない見た目を持たない(黙って捨てるだけ)── 章の欄は
 *   保存に「別の場所で書き換えられました」という**断られる**経路が在るので、
 *   user に**いま何が起きているか**を見せる価値がある(CLAUDE.md「無言の
 *   dead click を作らない」)。
 *
 * @returns 箱が見つからなければ何もしない(既に閉じている等の防波堤)。
 */
export function syncSectionBoxSaving(host: HTMLElement, saving: boolean): void {
  const box = host.querySelector<HTMLElement>(`[data-pkc-region="${SECTION_BOX_REGION}"]`);
  if (box === null) return;
  const save = box.querySelector<HTMLButtonElement>('[data-pkc-action="save-section-draft"]');
  const cancel = box.querySelector<HTMLButtonElement>('[data-pkc-action="cancel-section-draft"]');
  const release = box.querySelector<HTMLButtonElement>('[data-pkc-action="force-release"]');
  if (save !== null) {
    save.disabled = saving;
    save.textContent = saving ? '保存しています…' : '章を保存する';
  }
  if (cancel !== null) cancel.disabled = saving;
  // 🔴 **返ってこない保存の最後の出口は、保存中だけ見せる**(#1044 段2 4巡目の修理、T1)
  if (release !== null) release.hidden = !saving;
}

/**
 * いま出ている章の箱の打ちかけの字。居なければ `null`。
 * ⚠ **保存 / 移動の判定に使う** ── state には打ちかけの字を持たない
 *   (`cell-input.ts` と同じ「打ちかけは DOM に生かす」規律)。
 */
export function sectionBoxText(host: HTMLElement): string | null {
  return (
    host.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${SECTION_BOX_INPUT_FIELD}"]`)
      ?.value ?? null
  );
}
