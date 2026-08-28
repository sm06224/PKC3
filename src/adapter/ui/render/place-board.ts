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
  btn.title =
    title !== null
      ? '押すと、このノートを開きます'
      : 'このノートが見つかりません(消されたか、題名が変わった後に lid が変わった形です)';
}

/**
 * 描画済みの本文に、板の配置を当てる。⚠ **描画のたびに呼ぶ**(冪等)。
 *
 * @returns 置いた塊の数(0 = 板ではない ── 器の印も外す)
 */
export function applyPlaceLayout(
  host: HTMLElement,
  resolveTitle: (lid: string) => string | null,
): number {
  const blocks = [...host.querySelectorAll<HTMLElement>(PLACE_SELECTOR)];
  if (blocks.length === 0) {
    host.classList.remove('pkc-board-host');
    host.style.removeProperty('min-height');
    return 0;
  }
  host.classList.add('pkc-board-host');
  let bottom = 0;
  blocks.forEach((el, i) => {
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
     * 🔑 **何番目の塊か**を焼く ── 掴んで離したとき、この番号で本文の開き行を指す
     * (DOM の並び = 原文の並び。`place-notation.ts` の数え方と対)。
     */
    el.setAttribute('data-pkc-place-ordinal', String(i));
    ensureGrip(el);
    const lid = el.getAttribute('data-pkc-entry');
    if (lid !== null && lid !== '') ensureCard(el, lid, resolveTitle);
    bottom = Math.max(bottom, y + (h ?? 160));
  });
  // ⚠ いちばん下の塊まで scroll で届く高さを器に持たせる(絶対配置は流れに乗らない)
  host.style.minHeight = `${bottom + 40}px`;
  return blocks.length;
}
