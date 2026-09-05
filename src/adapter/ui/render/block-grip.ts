/**
 * 🔴 **本文の塊を掴む口**(#684 段①)── 読む面の塊の左余白に ⠿ を 1 個だけ浮かせる。
 *
 * > user 要望(2026-09-03): 段落や見出しの章を、本文の中で掴んで並べ替えたい。
 *
 * ## 口は器の**外**に 1 個だけ置き、乗せた塊の横へ移す
 *
 * 塊ごとに口を植えると `applyBlocks` の差分が「知らない子」として消す(確認の帯が
 * `detail-notice-slot` を器の外に置いた理由と同じ)。🔑 だから口は**面(pane / 留めた枠)**
 * に 1 個だけ置き、`pointerover` で host 直下の塊を特定して**その左**へ動かす。
 * ⚠ **塊そのものに `draggable` を付けない** ── 付けると字をドラッグで選べなくなる
 *   (段落の中で選択を始めた瞬間に塊が動き出す)。掴めるのは口だけ。
 *
 * ## 掴む範囲は原文で決める(3 通り。`binder.ts` の `directiveBlockAt` と同じ作法)
 *
 * | 塊 | 範囲 |
 * |---|---|
 * | 見出し | **章ごと**(`chapterSpanOf` ── 畳む範囲と同じ数え方) |
 * | `:::` の囲み / 板 | 開き〜閉じ(`blockSpanAt`)。**閉じていなければ口を出さない** |
 * | それ以外 | 刻印 `data-pkc-source-line`〜`-end` |
 *
 * ⚠ `:::` の `-end` は開き行である(閉じは属性を捨てる)ので、刻印だけで取ると
 *   囲みの中身が置き去りになる ── だから原文で取る。
 *
 * ## 出さない所
 *
 * 畳まれて `hidden` の塊 / 板の面(`.pkc-board-host` ── 板は自分の掴みを持つ)/
 * 添付の説明(そもそも `installBlockGrip` を呼ばない別経路)。
 *
 * ⚠ 口に載せる座標は**生の body**(刻印 + frontmatter ぶん)── `data-pkc-place-line`
 *   と同じ座標系。書く側(`MOVE_BLOCK` → `line-move.ts`)がそのまま読む。
 */
import { blockSpanAt } from '@features/markdown/source-blocks';
import { bodyBelowFrontmatter, frontmatterLineCount } from '@features/markdown/frontmatter';
import { chapterSpanOf, headingLevel } from './heading-fold';

/** 口の名前。⚠ `binder.ts` の `dragstart` がこの綴りで拾う。 */
export const BLOCK_GRIP_FIELD = 'block-grip';
/** 口に載せる範囲(生の body の行番号・両端含む)。 */
export const BLOCK_START_ATTR = 'data-pkc-block-start';
export const BLOCK_END_ATTR = 'data-pkc-block-end';
/** 口が指しているノート。⚠ 留めた枠の口は留めた lid を持つ(主の枠へ落ちない)。 */
export const BLOCK_LID_ATTR = 'data-pkc-block-lid';

/** 面ごとの「いま描いてある物」。口は面に 1 個なので、面を鍵にする。 */
interface Painted {
  host: HTMLElement;
  lid: string;
  /** frontmatter を剥いだ本文(刻印と同じ座標系)。 */
  fmBody: string;
  /** frontmatter の行数(刻印 → 生の body へ写す足し込み)。 */
  fm: number;
}

const painted = new WeakMap<HTMLElement, Painted>();
/** 口 → いま指している塊(`dragstart` が drag 像に使う)。 */
const gripTargets = new WeakMap<Element, HTMLElement>();

/**
 * 口を置く面。⚠ 主の器(`[data-pkc-split-main]`)は何も留めていない間 `display: contents`
 * で**箱を持たない**ので、そこに絶対配置しても位置が取れない ── 箱を持つ最も近い面
 * (留めた枠 = `split-frame` / 本文の面 = `view-pane`)へ置く。
 */
export function gripAnchorOf(region: HTMLElement): HTMLElement {
  return (
    region.closest<HTMLElement>('[data-pkc-region="split-frame"]') ??
    region.closest<HTMLElement>('[data-pkc-view-pane="detail"]') ??
    region
  );
}

/** 口が指している塊(無ければ `null`)。 */
export function grippedBlock(grip: Element): HTMLElement | null {
  return gripTargets.get(grip) ?? null;
}

function ensureGrip(anchor: HTMLElement): HTMLElement {
  let grip = anchor.querySelector<HTMLElement>(`[data-pkc-field="${BLOCK_GRIP_FIELD}"]`);
  if (grip === null) {
    grip = anchor.ownerDocument.createElement('button');
    (grip as HTMLButtonElement).type = 'button';
    grip.setAttribute('data-pkc-field', BLOCK_GRIP_FIELD);
    grip.setAttribute('draggable', 'true');
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    grip.setAttribute('aria-label', 'この塊を掴んで動かす');
    grip.title = 'この塊を掴んで、本文の別の場所へ動かします';
    grip.textContent = '⠿';
    grip.hidden = true;
    anchor.append(grip);
  }
  return grip;
}

/**
 * 塊の原文の行範囲(生の body の座標)。出さない塊は `null`。
 * ⚠ **host の直下だけ**を見る(`applyHeadingFold` と同じ塊の数え方)。
 */
function blockRange(p: Painted, block: HTMLElement): { start: number; end: number } | null {
  const line = Number(block.getAttribute('data-pkc-source-line'));
  if (!Number.isInteger(line) || line < 0) return null;
  if (headingLevel(block) > 0) {
    const span = chapterSpanOf(p.host, block, p.fmBody.split('\n').length);
    return span === null ? null : { start: span.start + p.fm, end: span.end + p.fm };
  }
  const directive = blockSpanAt(p.fmBody, line);
  if (directive !== null) {
    if (directive.open) return null; // 閉じていない ── 末尾まで飲んでいるので塊の範囲が無い
    return { start: line + p.fm, end: directive.end + p.fm };
  }
  const end = Number(block.getAttribute('data-pkc-source-end'));
  return { start: line + p.fm, end: (Number.isInteger(end) && end >= line ? end : line) + p.fm };
}

/** 押した所を包む host 直下の塊。host の外なら `null`。 */
function topBlockOf(host: HTMLElement, target: Element | null): HTMLElement | null {
  let el: Element | null = target;
  while (el !== null && el.parentElement !== host) el = el.parentElement;
  return el instanceof HTMLElement ? el : null;
}

function hide(grip: HTMLElement): void {
  if (!grip.hidden) grip.hidden = true;
  gripTargets.delete(grip);
}

/**
 * 乗せた所に応じて口を出す / 隠す。
 * ⚠ 位置は面からの相対(`getBoundingClientRect` の差)── 面は `position: relative`(app.css)。
 */
function follow(anchor: HTMLElement, grip: HTMLElement, target: Element | null): void {
  const p = painted.get(anchor);
  if (p === undefined || target === null) return hide(grip);
  if (target === grip || grip.contains(target)) return; // 口の上に居る ── そのまま
  // 板の面では出さない(板は自分の掴み ⠿ を持つ ── 2 つ並ぶと何が動くか読めない)
  if (p.host.classList.contains('pkc-board-host')) return hide(grip);
  const block = topBlockOf(p.host, target);
  if (block === null || block.hidden) return hide(grip);
  const range = blockRange(p, block);
  if (range === null) return hide(grip);
  grip.setAttribute(BLOCK_START_ATTR, String(range.start));
  grip.setAttribute(BLOCK_END_ATTR, String(range.end));
  grip.setAttribute(BLOCK_LID_ATTR, p.lid);
  gripTargets.set(grip, block);
  const a = anchor.getBoundingClientRect();
  const b = block.getBoundingClientRect();
  grip.style.top = `${b.top - a.top + anchor.scrollTop}px`;
  grip.style.left = `${gripLeft(a, b) + anchor.scrollLeft}px`;
  if (grip.hidden) grip.hidden = false;
}

/** 口の幅(px)。⚠ CSS(`[data-pkc-field='block-grip']` の `width`)と同じ値。 */
const GRIP_WIDTH = 18;

/**
 * 🔴 **口の横位置 ── 字の上に重ねない**(実ブラウザの smoke が拾った。2026-09-05)。
 *
 * ⚠ 1 稿目は「左余白、無ければ `max(0, …)` で塊の左端」だった。読む面の左余白は pane の
 *   padding(8px)しか無いので、**口が段落の先頭の字の上に 10px 重なり**、先頭の字を押すと
 *   選択ではなく掴みになった(字の選択を殺さない、という段①の約束の当の破れ)。
 * 🔑 左に入らなければ**塊の右**(読み幅 672px の右は広い)。右にも入らなければ左端に重ねる
 *   (面の外へ出すと scroller に切られて掴めない)。
 * 🔴 **左へ置くときは、見出しの畳みの帯の外側に置く**(CI の `heading-look` smoke が拾った)。
 *   帯(`heading-fold`)は見出しの左端から **3px 外**へ張り出している(`app.css` の
 *   `inset-inline-start: -3px`)── 口の右端を塊の左端に揃えると帯に 3px 重なり、
 *   **帯そのものが畳みのボタン**という既存の動線を口が塞ぐ(hover が口に取られる)。
 *
 * @param a 置き場(面)の矩形 @param b 塊の矩形 @returns 面の左からの位置(px。scroll は呼び側が足す)
 */
export function gripLeft(
  a: { left: number; right: number },
  b: { left: number; right: number },
): number {
  const leftRoom = b.left - a.left;
  if (leftRoom >= GRIP_WIDTH + LEFT_CLEARANCE) return leftRoom - GRIP_WIDTH - LEFT_CLEARANCE;
  const rightRoom = a.right - b.right;
  if (rightRoom >= GRIP_WIDTH + GRIP_GAP) return b.right - a.left + GRIP_GAP;
  return Math.max(0, leftRoom - GRIP_WIDTH);
}

/** 右へ置くときの、塊と口のあき(px)。 */
const GRIP_GAP = 2;
/**
 * 左へ置くときの、塊の左端と口の右端のあき(px)= 畳みの帯の張り出し 3px + あき 2px。
 * ⚠ 3 は `app.css` の `[data-pkc-field='heading-fold'] { inset-inline-start: -3px }` と同じ値。
 */
const LEFT_CLEARANCE = 5;

/**
 * 読む面に掴む口を配線する。⚠ **描画のたびに呼ぶ**(冪等)── 面が持つ「いま描いてある物」
 * を差し替えるだけで、listener は面に 1 度しか張らない。
 *
 * @param region その面の器(`DetailRenderer` の `region`)。口は `gripAnchorOf(region)` へ置く
 * @param host   markdown を描いた器(`detail-body` / `split-body`)
 * @param lid    描いてあるノート
 * @param body   生の本文(frontmatter 込み)
 */
export function installBlockGrip(region: HTMLElement, host: HTMLElement, lid: string, body: string): void {
  const anchor = gripAnchorOf(region);
  const first = !painted.has(anchor);
  painted.set(anchor, { host, lid, fmBody: bodyBelowFrontmatter(body), fm: frontmatterLineCount(body) });
  const grip = ensureGrip(anchor);
  if (first) {
    anchor.addEventListener('pointerover', (e) => {
      const g = anchor.querySelector<HTMLElement>(`[data-pkc-field="${BLOCK_GRIP_FIELD}"]`);
      if (g !== null) follow(anchor, g, e.target as Element | null);
    });
    anchor.addEventListener('pointerleave', () => {
      const g = anchor.querySelector<HTMLElement>(`[data-pkc-field="${BLOCK_GRIP_FIELD}"]`);
      if (g !== null) hide(g);
    });
    // ⚠ 落とした後は塊が動いているので、古い位置に口を残さない
    anchor.addEventListener('dragend', () => {
      const g = anchor.querySelector<HTMLElement>(`[data-pkc-field="${BLOCK_GRIP_FIELD}"]`);
      if (g !== null) hide(g);
    });
  }
  // 描き直しで塊が入れ替わっていることがある ── 指していた塊が外れていたら隠す
  const shown = gripTargets.get(grip);
  if (shown !== undefined && (!shown.isConnected || shown.parentElement !== host)) hide(grip);
}
