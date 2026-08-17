/**
 * 🔴 **画面と同じ HTML から、Word へ写す塊の列を作る**(#187 段①)。
 *
 * 🔑 **レンダラを 2 本にしない**(設計 doc `office-export-design-2026-08.md` §1-2)。
 * PKC2 は画面(markdown-it)と書き出し(別の AST 系)で**別々に描いていた**ので、
 * 「Word で直した」が PDF に届かず、記録されている不具合はほぼ全部その土台に
 * 乗っていた。だから入力は **`renderBody` が返す画面と同じ HTML** である。
 *
 * ⚠ **ここは adapter**(DOM を読むので `features/` に置けない)。
 * 写す規則そのものは `features/export/docx.ts` の純関数側に在る ── この file の
 * 仕事は「HTML の木を、平らな塊の列へ畳む」だけに閉じる。
 *
 * ## 写すもの・写さないもの(黙って落とさない)
 *
 * - **添付の画像**は写す(段②)── ただし bytes と実寸は adapter の上位が解くので、
 *   ここでは**場所を預ける**だけ(`images`)。解けなければ `skipped` のまま出る
 * - **添付でない画像**(外から読むもの)/ `<svg>`(図)/ `<iframe>`(html fence の箱)/
 *   `<canvas>` は写さない ── `skipped` として**その場に理由を出す**
 * ⚠ PKC2 は失敗を `console.warn` にしか書かず、user から見ると
 *   「ボタンを押して何も起きない」が正常動作だった。
 */
import type { DocxBlock, DocxCell, DocxRun } from '@features/export/docx';

/** 走りに掛かる装飾(親から受け継ぐ)。 */
interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
  href?: string;
}

/** 走りを畳んで積む(空の走りは捨てる)。 */
function pushRun(out: DocxRun[], text: string, style: RunStyle): void {
  if (text === '') return;
  const last = out[out.length - 1];
  // ⚠ 同じ装飾が続くなら 1 つに畳む(段落あたりの `<w:r>` を無駄に増やさない)
  if (
    last !== undefined &&
    last.bold === style.bold &&
    last.italic === style.italic &&
    last.strike === style.strike &&
    last.mono === style.mono &&
    last.href === style.href
  ) {
    out[out.length - 1] = { ...last, text: last.text + text };
    return;
  }
  out.push({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.mono ? { mono: true } : {}),
    ...(style.href !== undefined ? { href: style.href } : {}),
  });
}

/** 見出しの階層。⚠ `h7` は無いので 6 に丸める(段落ごと落とさない)。 */
function headingLevel(tag: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const m = /^h([1-6])$/.exec(tag);
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6) : null;
}

/**
 * 写せない要素の呼び名(user に見せる語)。
 * ⚠ **内部語を出さない**(`iframe` ではなく「埋め込みの箱」)。
 */
function skippedName(el: Element): { what: string; why: string } | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') {
    const alt = el.getAttribute('alt') ?? '';
    // ⚠ **添付の画像は別扱い**(#187 段②)── ここへ来るのは添付でない画像だけ
    return {
      what: alt !== '' ? `画像「${alt}」` : '画像',
      why: '添付ではない画像は Word に入れていません',
    };
  }
  if (tag === 'svg') return { what: '図(ベクタ)', why: 'この版では図を Word に入れていません' };
  if (tag === 'iframe') return { what: '埋め込みの箱', why: 'Word では動きません' };
  if (tag === 'canvas') return { what: '描画の面', why: 'Word では動きません' };
  return null;
}

/**
 * 図・グラフの器(`markdown-render.ts` が fence から作る)。
 * ⚠ **属性の名前は 1 か所で持つ** ── 焼く側(`mermaid-hydrate` / `chart-raster` の
 * `DiagramKind.attr`)と同じ文字列である。片方だけ変えると、器は在るのに
 * 誰も拾わない(= 原文が等幅で出る)状態に静かに戻る。
 */
const FIGURE_ATTR: readonly [string, string][] = [
  ['data-pkc-mermaid-src', 'mermaid'],
  ['data-pkc-chart-src', 'chart'],
];

/** user に見せる呼び名(内部語を出さない)。 */
const FIGURE_NAME: Record<string, string> = { mermaid: '図', chart: 'グラフ' };

function figureOf(el: Element): { kind: string; source: string } | null {
  for (const [attr, kind] of FIGURE_ATTR) {
    const source = el.getAttribute(attr);
    if (source !== null && source !== '') return { kind, source };
  }
  return null;
}

/**
 * HTML(画面と同じもの)→ 塊の列。
 *
 * @param doc `DOMParser` で読んだ document(呼び側が作る ── ここでは作らない。
 *   テストから happy-dom の document をそのまま渡せるようにするため)
 */
export function htmlToDocxBlocks(doc: Document): {
  blocks: DocxBlock[];
  skipped: number;
  /**
   * 🔴 **添付の画像の預かり**(#187 段②)。ここでは **bytes も実寸も解けない**
   * (store と `createImageBitmap` は adapter の上位が持つ)ので、**場所だけ**返す。
   * 呼び側が解いて `blocks[at]` を `image` か `skipped` に**差し替える**。
   * ⚠ 差し替えを忘れると `skipped` のまま出る = **黙って落ちない**(安全側)。
   */
  images: { at: number; assetKey: string; alt: string }[];
  /**
   * 🔴 **図とグラフの預かり**(#187 段②)。⚠ ここでは**焼けない**(mermaid /
   * chart.js は adapter の上位が持つ)ので、**原文と場所**だけ返す。
   *
   * ⚠ **預けないと、原文が等幅の文字として出る** ── 器の中には原文の
   * `<pre><code>` が入っているので、素通しすると **PKC2 とまったく同じ失敗**
   * (「図は原文が黙って等幅で出る」)を再演する。実際に段① はそうなっていた。
   */
  figures: { at: number; kind: string; source: string }[];
} {
  const blocks: DocxBlock[] = [];
  const images: { at: number; assetKey: string; alt: string }[] = [];
  const figures: { at: number; kind: string; source: string }[] = [];
  let skipped = 0;

  /** 要素の中の文字を走りへ(木を辿って装飾を受け継ぐ)。 */
  const collectRuns = (node: Node, style: RunStyle, out: DocxRun[]): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // ⚠ HTML の折り返しは**空白 1 つ**に潰す(markdown-it は行末で改行を入れる)
        pushRun(out, (child.textContent ?? '').replace(/\s*\n\s*/g, ' '), style);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      const assetKey = el.tagName.toLowerCase() === 'img' ? el.getAttribute('data-pkc-asset-key') : null;
      if (assetKey !== null && assetKey !== '') {
        /**
         * 🔑 **添付の画像は段落の外へ出す**(#187 段②)。Word の画像は走りに
         * 入れられるが、本文と混ぜると行の高さが暴れる ── 1 枚 1 段落にする。
         * ⚠ ここでは**場所を予約するだけ** ── bytes と実寸は呼び側が解く
         * (解けなければ `skipped` のまま出るので、黙って消えない)。
         */
        const alt = el.getAttribute('alt') || el.getAttribute('data-pkc-asset-name') || '画像';
        images.push({ at: blocks.length, assetKey, alt });
        blocks.push({ kind: 'skipped', what: `画像「${alt}」`, why: '取り出せませんでした' });
        continue;
      }
      const gone = skippedName(el);
      if (gone !== null) {
        skipped += 1;
        // ⚠ 段落の**中**に在った画像も、理由を文字として残す(黙って消さない)
        pushRun(out, `［${gone.what} は写せませんでした: ${gone.why}］`, { ...style, italic: true });
        continue;
      }
      if (tag === 'br') {
        pushRun(out, '\n', style);
        continue;
      }
      const next: RunStyle = { ...style };
      if (tag === 'strong' || tag === 'b') next.bold = true;
      if (tag === 'em' || tag === 'i') next.italic = true;
      if (tag === 's' || tag === 'del') next.strike = true;
      if (tag === 'code' || tag === 'kbd' || tag === 'samp') next.mono = true;
      if (tag === 'a') {
        const href = el.getAttribute('href') ?? '';
        // ⚠ **外向きのリンクだけ** rel を張る。`#slug` や `pkc://` は Word で
        //    行き先が無いので、素の文字として残す(壊れたリンクを作らない)
        if (/^https?:\/\//.test(href)) next.href = href;
      }
      collectRuns(el, next, out);
    }
  };

  const runsOf = (el: Element): DocxRun[] => {
    const out: DocxRun[] = [];
    collectRuns(el, {}, out);
    return out;
  };

  /** 箇条書き(入れ子は `depth` で平らにする)。 */
  const walkList = (list: Element, depth: number, ordered: boolean): void => {
    for (const li of Array.from(list.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      // ⚠ 子の `ul` / `ol` は**先に外す** ── 外さないと親の行に子の文字が混ざる
      const nested = Array.from(li.children).filter((c) =>
        ['ul', 'ol'].includes(c.tagName.toLowerCase()),
      );
      const clone = li.cloneNode(true) as Element;
      for (const c of Array.from(clone.children))
        if (['ul', 'ol'].includes(c.tagName.toLowerCase())) c.remove();
      const runs = runsOf(clone);
      if (runs.length > 0 || nested.length === 0)
        blocks.push({ kind: 'li', ordered, depth, runs });
      for (const sub of nested)
        walkList(sub, depth + 1, sub.tagName.toLowerCase() === 'ol');
    }
  };

  const walkBlocks = (parent: Element): void => {
    /**
     * 🔴 **fence は「画面に見えている面」だけを写す**(2026-08-17。段① の穴)。
     *
     * `markdown-render.ts` は fence を **描画の面(`.pkc-render-slot`)と
     * 原文の面(`pre.pkc-render-source`)の両方**で出し、どちらを見せるかは
     * CSS の切替で決めている(既定は描画)。⚠ 書き出しに CSS は無いので、
     * **素通しすると 2 つとも出る** ── 表と csv の原文、図と図の原文が並ぶ。
     * (実測: `csv` fence が表 + 原文、`mermaid` が図 + 原文で出ていた)
     *
     * ⚠ 印(`data-pkc-render-mode`)は**見ない**。この class を持つ `<pre>` は
     * その器の中にしか出ない(原文で見せる指定 `-norender` は器ごと出ず、
     * **素の `<pre>`** になる ── 実測)ので、親を見る条件は
     * **絶対に発火しない行**になる(= 変異試験で殺せない = 置かない)。
     */
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      /**
       * 🔴 **画面の道具は文書ではない**(同上)。コピーの ⧉ と切替の ‹/› は
       * fence ごとに付く器なので、素通しすると**塊ごとに ⧉ の段落**が入る
       * (実測: ふつうのコード塊でも 1 つ入っていた)。
       */
      if (tag === 'button' || tag === 'input' || tag === 'label') continue;
      if (el.classList.contains('pkc-render-source')) continue;
      const level = headingLevel(tag);
      if (level !== null) {
        blocks.push({ kind: 'h', level, runs: runsOf(el) });
        continue;
      }
      if (tag === 'p') {
        const runs = runsOf(el);
        // ⚠ 空段落は捨てる(画像だけの段落は上で `skipped` の文字になっている)
        if (runs.length > 0) blocks.push({ kind: 'p', runs });
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        walkList(el, 0, tag === 'ol');
        continue;
      }
      if (tag === 'blockquote') {
        // ⚠ 引用の中の段落は**引用として**平らにする(入れ子は持たない)
        const inner = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'p');
        if (inner.length === 0) blocks.push({ kind: 'quote', runs: runsOf(el) });
        else for (const p of inner) blocks.push({ kind: 'quote', runs: runsOf(p) });
        continue;
      }
      if (tag === 'pre') {
        const code = el.querySelector('code');
        const cls = code?.getAttribute('class') ?? '';
        const lang = /language-([\w+-]+)/.exec(cls)?.[1];
        blocks.push({
          kind: 'code',
          text: (code ?? el).textContent ?? '',
          ...(lang !== undefined ? { lang } : {}),
        });
        continue;
      }
      if (tag === 'hr') {
        blocks.push({ kind: 'hr' });
        continue;
      }
      if (tag === 'table') {
        const rows: DocxCell[][] = [];
        for (const tr of Array.from(el.querySelectorAll('tr'))) {
          const cells: DocxCell[] = [];
          for (const cell of Array.from(tr.children)) {
            const isTh = cell.tagName.toLowerCase() === 'th';
            cells.push({ runs: runsOf(cell), ...(isTh ? { header: true } : {}) });
          }
          if (cells.length > 0) rows.push(cells);
        }
        if (rows.length > 0) blocks.push({ kind: 'table', rows });
        continue;
      }
      /**
       * 🔴 **図・グラフは器ごと預ける**(#187 段②)。⚠ **降りる前に**拾う ──
       * 器の中には原文の `<pre><code>` が在るので、降りると「図の原文が等幅で
       * 出る」(PKC2 の失敗そのもの)になる。⚠ 焼けなければ `skipped` のまま出る。
       */
      const fig = figureOf(el);
      if (fig !== null) {
        figures.push({ at: blocks.length, ...fig });
        blocks.push({
          kind: 'skipped',
          what: FIGURE_NAME[fig.kind] ?? '図',
          why: '描けませんでした',
        });
        continue;
      }
      const bkey = tag === 'img' ? el.getAttribute('data-pkc-asset-key') : null;
      if (bkey !== null && bkey !== '') {
        const alt = el.getAttribute('alt') || el.getAttribute('data-pkc-asset-name') || '画像';
        images.push({ at: blocks.length, assetKey: bkey, alt });
        blocks.push({ kind: 'skipped', what: `画像「${alt}」`, why: '取り出せませんでした' });
        continue;
      }
      const gone = skippedName(el);
      if (gone !== null) {
        skipped += 1;
        blocks.push({ kind: 'skipped', ...gone });
        continue;
      }
      // ⚠ 知らない器(`div` / `section` / `details`)は**中へ降りる** ──
      //    降りないと、囲みの中の本文が丸ごと消える(PKC2 の `:::` がそうだった)
      if (el.children.length > 0) {
        walkBlocks(el);
        continue;
      }
      const runs = runsOf(el);
      if (runs.length > 0) blocks.push({ kind: 'p', runs });
    }
  };

  walkBlocks(doc.body);
  return { blocks, skipped, images, figures };
}
