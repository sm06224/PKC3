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

const PLACE_SELECTOR = '.pkc-format-block.pkc-place';

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
  // ⚠ いちばん下の塊まで scroll で届く高さを器に持たせる(絶対配置は流れに乗らない)
  host.style.minHeight = `${bottom + 40}px`;
  // 🔑 口を作り直した**後**に返す(前に返すと、返した先が次の行で差し替わる)
  restoreGripFocus(host);
  return blocks.length;
}
