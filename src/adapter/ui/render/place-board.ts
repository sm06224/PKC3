/**
 * 🔴 **自由配置の板を器へ当てる**(#283 P4-a)。規則(どの行が板の塊か・
 * どう書き換えるか)は `features/markdown/place-notation.ts`(pure)──
 * ここは**描画済みの塊に位置を当てるだけ**。
 *
 * ## ⚠ 描画のたびに呼ぶ(冪等)
 *
 * `applyBlocks` は描画 HTML どうしを比べるので、ここで足す掴む口・題名の札は
 * 差分に影響しない。⚠ ただし塊が差し替わると消えるので、**描画のたびに呼び直す**
 * (`applyHeadingFold` と同じ作法)。
 *
 * ## ⚠ 展開(transclusion)はしない(裁定 2026-08-19 Q1)
 *
 * `entry=` の塊は**題名の札**である ── 中身を写すと正本が 2 つになる。
 * 開けば本体へ飛ぶ(`select-entry` の既存の口に乗せる)。
 *
 * ## ⚠ 節点の親子は動かさない
 *
 * 畳み(heading-fold)と同じ理由 ── ライブエディタ(`row-swap`)は塊が
 * host の直下であることを前提にしている。位置は style で当てるだけ。
 */

import {
  placeLineOf,
  placeLineTargetId,
  type PlaceRect,
} from '@features/markdown/place-line';

/**
 * 🔑 **測れない所で使う大きさ**(happy-dom / まだ画面に出ていない面)。
 * ⚠ CSS の `min-width` / `min-height` と**同じ数**にする ── 別の数を書くと、
 *   測れる所と測れない所で線の行き先が変わる(§7「同じ値が 2 か所」)。
 */
const PLACE_FALLBACK_W = 120;
const PLACE_FALLBACK_H = 40;

const PLACE_SELECTOR = '.pkc-format-block.pkc-place';

/** 線の宣言の塊。⚠ **中身を描かない**(座標を持たない「指すだけ」の塊である)。 */
const LINE_SELECTOR = '.pkc-format-block.pkc-line';

/** 引いた線を入れる 1 枚。⚠ **線ごとに `<svg>` を作らない**(重ねると当たり判定が塞がる)。 */
const LINE_LAYER = 'data-pkc-field="place-lines"';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 🔴 **矢印キーで動かした後、焦点を返す先**(#676 段②)── 器に焼く印(値 = 開き行の行番号)。
 *
 * ⚠ 本文へ書くと再描画で塊が差し替わり、掴む口も作り直されて**焦点が本文の外へ落ちる**
 *   (`place-board.ts` 冒頭の「描画のたびに呼ぶ」の帰結)。1 押し = 1 回落ちる形では
 *   矢印で動かし続けられない。
 * 🔑 書く側(`place-drag.ts`)は器にこの印を置くだけ、返すのは `applyPlaceLayout`(= 口を
 *   作り直す当の関数)── 「いつ口ができるか」を知っている側が返す。印は 1 度使ったら外す。
 */
export const PLACE_FOCUS_ATTR = 'data-pkc-place-focus';

/** 印が在れば、その開き行の塊の掴む口へ焦点を返して印を外す。 */
function restoreGripFocus(host: HTMLElement): void {
  const line = host.getAttribute(PLACE_FOCUS_ATTR);
  if (line === null) return;
  host.removeAttribute(PLACE_FOCUS_ATTR);
  host
    .querySelector<HTMLElement>(
      `${PLACE_SELECTOR}[data-pkc-place-line="${line}"] > [data-pkc-field="place-grip"]`,
    )
    ?.focus();
}

/** 属性の整数(0 以上)。⚠ 読めない値は「無い」扱い(黙って 0 にしない)。 */
function intAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * 掴む口を 1 つだけ置く(冪等)。
 * ⚠ `<button>` にする ── `row-swap` が button を編集の対象から外しているので、
 *   掴もうとして編集に落ちない(heading-fold の口と同じ理由)。
 * ⚠ 字は `textContent` に入れない(見出しの畳みで実際に踏んだ)── 印は CSS で出す。
 */
function ensureGrip(el: HTMLElement): void {
  let grip = el.querySelector<HTMLButtonElement>(':scope > [data-pkc-field="place-grip"]');
  if (grip === null) {
    grip = el.ownerDocument.createElement('button');
    grip.type = 'button';
    grip.setAttribute('data-pkc-field', 'place-grip');
    grip.textContent = '';
    el.prepend(grip);
  }
  // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
  const label = '掴んで動かします(離した位置が本文に書かれます)';
  grip.title = label;
  grip.setAttribute('aria-label', label);
}

/**
 * 🔴 **大きさを変える持ち手**を右下に 1 つ置く(#676。冪等)。
 * 掴む口(`ensureGrip`)と同じ作法 ── `<button>` / 字は CSS / 文言は起きることで書く。
 * 掴んだときの振る舞いは `place-drag.ts` の `mode: 'size'`。
 */
function ensureSizeHandle(el: HTMLElement): void {
  let handle = el.querySelector<HTMLButtonElement>(':scope > [data-pkc-field="place-size"]');
  if (handle === null) {
    handle = el.ownerDocument.createElement('button');
    handle.type = 'button';
    handle.setAttribute('data-pkc-field', 'place-size');
    handle.textContent = '';
    el.append(handle);
  }
  const label = '角を掴んで大きさを変えます(離した大きさが本文に書かれます)';
  handle.title = label;
  handle.setAttribute('aria-label', label);
}

/**
 * `entry=` の塊に**題名の札**を出す(冪等)。
 * ⚠ 相手が消えていても**黙って空にしない**(関係の行と同じ向き)。
 */
function ensureCard(
  el: HTMLElement,
  lid: string,
  resolveTitle: (lid: string) => string | null,
): void {
  let btn = el.querySelector<HTMLButtonElement>(':scope > [data-pkc-field="place-card"]');
  if (btn === null) {
    btn = el.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-field', 'place-card');
    btn.setAttribute('data-pkc-action', 'select-entry');
    el.append(btn);
  }
  btn.setAttribute('data-pkc-entry', lid);
  const title = resolveTitle(lid);
  const shown = title ?? '(見つかりません)';
  if (btn.textContent !== shown) btn.textContent = shown;
  // ⚠ いちばん多い原因(ID の貼り間違い)を先に言う ── 「消えた」から言うと、
  //   user は消えていないノートを探しに行く(UX レビュー 2026-08-28)
  btn.title =
    title !== null
      ? '押すと、このノートを開きます'
      : 'ID が違うか、ノートが消されています。ID は entry: の後ろの英数字だけです(entry: や閉じ括弧は含めません)';
}

/**
 * 🔴 **板 1 枚の場所と大きさを採る**(#530 段③a)。
 *
 * 🔑 **測れるなら測る** ── `w=` / `h=` を省いた板は、大きさが**中身と CSS で決まる**
 *   (`min-width: 120px` / `min-height: 40px` + 中身)ので、札だけ読むと線が外れる。
 * ⚠ **測れない所では札へ落とす**(happy-dom は 0 を返す ── そこで 0 を信じると、
 *   線が全部左上の 1 点へ集まる)。CLAUDE.md §2 の「本命の分岐を unit は通らない」型なので、
 *   **落とし先まで含めて** unit で見る。
 */
function rectOf(el: HTMLElement): PlaceRect {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  return {
    x: intAttr(el, 'data-pkc-x') ?? 0,
    y: intAttr(el, 'data-pkc-y') ?? 0,
    w: w > 0 ? w : (intAttr(el, 'data-pkc-w') ?? PLACE_FALLBACK_W),
    h: h > 0 ? h : (intAttr(el, 'data-pkc-h') ?? PLACE_FALLBACK_H),
  };
}

/**
 * 🔴 **`from=` / `to=` の線を 1 枚の `<svg>` に引く**(#530 段③a)。
 *
 * ⚠ **指す先が無い線は、黙って飛ばす**(描かない)── 板を消したのに線が残った本文で、
 *   画面のどこにも行かない線を出さないため。⚠ ただし**本文からは消さない**
 *   (user が書いた字を、こちらの都合で書き換えない)。
 * ⚠ **`pointer-events: none`** を層に当てる ── 当てないと、線の層が板の上に載って
 *   **掴む口が押せなくなる**(無言の dead click)。規則は CSS 側が持つ。
 */
function applyPlaceLines(host: HTMLElement, boards: readonly HTMLElement[]): number {
  const old = host.querySelector(`[${LINE_LAYER}]`);
  const decls = [...host.querySelectorAll<HTMLElement>(LINE_SELECTOR)];
  if (decls.length === 0 || boards.length === 0) {
    old?.remove();
    return 0;
  }
  const byId = new Map<string, HTMLElement>();
  for (const el of boards) if (el.id !== '') byId.set(el.id, el);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-pkc-field', 'place-lines');
  let drawn = 0;
  for (const d of decls) {
    const from = byId.get(placeLineTargetId(d.getAttribute('data-pkc-from')) ?? '');
    const to = byId.get(placeLineTargetId(d.getAttribute('data-pkc-to')) ?? '');
    if (from === undefined || to === undefined || from === to) continue;
    const ln = placeLineOf(rectOf(from), rectOf(to));
    const el = document.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', String(ln.x1));
    el.setAttribute('y1', String(ln.y1));
    el.setAttribute('x2', String(ln.x2));
    el.setAttribute('y2', String(ln.y2));
    // 🔑 どの辺から出たかを焼く ── 段③b(束ねる)と smoke の観測点になる
    el.setAttribute('data-pkc-line-from', ln.from);
    el.setAttribute('data-pkc-line-to', ln.to);
    svg.append(el);
    drawn += 1;
  }
  old?.remove();
  if (drawn === 0) return 0;
  // ⚠ **いちばん先頭へ置く** ── 板より後ろに敷く(線が板の上に乗ると字が読めない)
  host.prepend(svg);
  return drawn;
}

/**
 * 描画済みの本文に、板の配置を当てる。⚠ **描画のたびに呼ぶ**(冪等)。
 *
 * @param lineOffset 描画の `data-pkc-source-line`(frontmatter を剥がした本文の
 *   行番号)を**生の body の行番号**へ写す足し込み(= `frontmatterLineCount`。
 *   `taskLineOffset` と同じ 1 つの値を detail が渡す)。
 * @returns 置いた塊の数(0 = 板ではない ── 器の印も外す)
 */
export function applyPlaceLayout(
  host: HTMLElement,
  resolveTitle: (lid: string) => string | null,
  lineOffset: number,
): number {
  const blocks = [...host.querySelectorAll<HTMLElement>(PLACE_SELECTOR)];
  if (blocks.length === 0) {
    host.classList.remove('pkc-board-host');
    host.style.removeProperty('min-height');
    host.removeAttribute(PLACE_FOCUS_ATTR); // 返す先が無い ── 印だけ残さない
    // ⚠ **前に引いた線を残さない** ── 板を全部消した本文で、線だけが宙に残る
    host.querySelector(`[${LINE_LAYER}]`)?.remove();
    return 0;
  }
  host.classList.add('pkc-board-host');
  let bottom = 0;
  for (const el of blocks) {
    const x = intAttr(el, 'data-pkc-x') ?? 0;
    const y = intAttr(el, 'data-pkc-y') ?? 0;
    const w = intAttr(el, 'data-pkc-w');
    const h = intAttr(el, 'data-pkc-h');
    const z = intAttr(el, 'data-pkc-z');
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (w !== null) el.style.width = `${w}px`;
    else el.style.removeProperty('width');
    if (h !== null) el.style.height = `${h}px`;
    else el.style.removeProperty('height');
    if (z !== null) el.style.zIndex = String(z);
    else el.style.removeProperty('z-index');
    /**
     * 🔑 **開き行の行番号**(生の body 基準)を焼く ── 掴んで離したとき、
     * この行番号で本文の開き行を指す。描画が焼いた `data-pkc-source-line` に
     * frontmatter ぶんを足す(`data-pkc-task-line` と同じ座標系)。
     * ⚠ 数え直しの第 2 の規則を持たない ── 初版の「N 番目」方式は、描画と
     *   別に数えたせいで**掴んだ付箋と別の行に書いた**(レビュー実測 2026-08-28)。
     */
    const src = intAttr(el, 'data-pkc-source-line');
    if (src !== null) el.setAttribute('data-pkc-place-line', String(src + lineOffset));
    else el.removeAttribute('data-pkc-place-line');
    /**
     * 🔴 塊の `data-pkc-entry`(`entry=` の kv がそのまま焼かれた物)は
     * **名前を替えて外す** ── binder の `toggle-task` / `edit-cell` は lid を
     * `closest('[data-pkc-entry]')` で引くので、札の中にチェックリストを書くと
     * **押した印が別ノートの同じ行番号に書かれる**(レビュー実測 2026-08-28)。
     * 札のボタン自身の `data-pkc-entry` は残す(押す動線はそちらが受ける)。
     */
    const rawEntry = el.getAttribute('data-pkc-entry');
    if (rawEntry !== null) {
      el.setAttribute('data-pkc-place-entry', rawEntry);
      el.removeAttribute('data-pkc-entry');
    }
    ensureGrip(el);
    ensureSizeHandle(el);
    const lid = el.getAttribute('data-pkc-place-entry');
    if (lid !== null && lid !== '') ensureCard(el, lid, resolveTitle);
    bottom = Math.max(bottom, y + (h ?? 160));
  }
  // 🔑 **線は板を置いた後に引く**(位置が当たっていないと行き先が決まらない)
  applyPlaceLines(host, blocks);
  // ⚠ いちばん下の塊まで scroll で届く高さを器に持たせる(絶対配置は流れに乗らない)
  host.style.minHeight = `${bottom + 40}px`;
  // 🔑 口を作り直した**後**に返す(前に返すと、返した先が次の行で差し替わる)
  restoreGripFocus(host);
  return blocks.length;
}
