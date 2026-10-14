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
import { parsePlaceColor, parsePlaceWidth, placeArrowOf, placeSizeOf } from '@features/markdown/place-color';
import { parsePlaceGroup } from '@features/markdown/place-notation';
import { placeRotateOf } from '@features/markdown/place-rotate';
import { placeShapeOf } from '@features/markdown/place-shape';
import { ADOPT_IMAGES_LABEL } from '@features/entry-actions';
import {
  anchorSpell,
  parseRouteSpell,
  placeLineAnchorOf,
  placeLineTargetId,
} from '@features/markdown/place-line';
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

/** 中身の字を別の行にする要素(セル・項目の中で、前後の字とつながらないようにする)。 */
const RUN_BREAK_TAGS: ReadonlySet<string> = new Set(['p', 'ul', 'ol', 'li', 'div']);

/** 前に出した字が在って、改行で終わっていないときだけ改行を 1 つ入れる。 */
function breakRun(out: DocxRun[], style: RunStyle): void {
  const last = out[out.length - 1];
  if (last === undefined || last.text.endsWith('\n')) return;
  pushRun(out, '\n', style);
}

/** 見出しの階層。⚠ `h7` は無いので 6 に丸める(段落ごと落とさない)。 */
/**
 * 板の位置の属性を読む(#530 段①)。⚠ 描画側(`place-board.ts` の `intAttr`)と
 * **同じ意味論**にする ── 無ければ `null`、数でなければ `null`。
 * 🔑 ここで既定値を作らない(描画と別の規則を持つと、画面と生成物がずれる)。
 */
function pxAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

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
      why: `添付ではない画像は入れていません(ウェブ上の画像なら、右のペインの「${ADOPT_IMAGES_LABEL}」で取り込んでから書き出すと入ります)`,
    };
  }
  if (tag === 'svg') return { what: '図(ベクタ)', why: 'このバージョンでは、この図は入れていません' };
  if (tag === 'iframe') return { what: '埋め込み枠', why: '書き出したファイルでは動きません' };
  if (tag === 'canvas') return { what: '描画領域', why: '書き出したファイルでは動きません' };
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

/**
 * 数式の器の名前(#707)。⚠ **`FIGURE_ATTR` に足さない** ── あちらは
 * 「呼び側が焼いて差し替える」預かりの一覧で、数式は焼かずに**字で書く**。
 * 同じ表に混ぜると、呼び側が焼こうとして空の器を出す。
 */
const MATH_ATTR = 'data-pkc-math-src';

/** 数式を Word へ書くときの字(⚠ 打った区切りごと残す)。 */
function mathText(el: Element, src: string): string {
  return el.getAttribute('data-pkc-math-display') === '1' ? `$$${src}$$` : `$${src}$`;
}

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

  /** 直前の兄弟が段落を作る要素か(後ろへ続く字を別の行にする合図)。 */
  const afterBlock = (n: Node): boolean => {
    const prev = n.previousSibling;
    return prev !== null && prev.nodeType === 1 && RUN_BREAK_TAGS.has((prev as Element).tagName.toLowerCase());
  };

  /** 要素の中の文字を走りへ(木を辿って装飾を受け継ぐ)。 */
  const collectRuns = (node: Node, style: RunStyle, out: DocxRun[]): void => {
    for (const child of Array.from(node.childNodes)) {
      /**
       * 🔴 **段落を作る要素の境目で改行を入れる**(セルや項目の中の `ul` / `p`)。
       * 入れないと表のセルの中の箇条書き `a` `b` が `ab` につながる。⚠ 先頭と末尾には入れない
       * (中身が空のときに空行を作らない)── 「前に出した字がある」ときだけ。
       */
      if (child.nodeType === 3) {
        /**
         * 🔑 **塊と塊のあいだの、改行だけの字は捨てる**(markdown-it が要素の間に入れる整形。
         * 捨てないと項目やセルの先頭・末尾に空白の走りが付く)。⚠ 字のある文や、
         * 行内の要素どうしのあいだ(`<em>a</em>\n<em>b</em>`)の空白は残す。
         */
        const raw = child.textContent ?? '';
        if (/^\s*$/.test(raw) && raw.includes('\n')) {
          const before = child.previousSibling;
          const after = child.nextSibling;
          const edge = (n: Node | null): boolean =>
            n === null || (n.nodeType === 1 && RUN_BREAK_TAGS.has((n as Element).tagName.toLowerCase()));
          if (edge(before) || edge(after)) continue;
        }
        if (afterBlock(child)) breakRun(out, style);
        // ⚠ HTML の折り返しは**空白 1 つ**に潰す(markdown-it は行末で改行を入れる)
        pushRun(out, (child.textContent ?? '').replace(/\s*\n\s*/g, ' '), style);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (afterBlock(child)) breakRun(out, style);
      /**
       * 🔴 **画面の道具は文書ではない**(`walkBlocks` と同じ)。コードの ⧉ と切替の ‹/› は
       * 箇条書きの項目の中の fence にも付くので、ここで落とさないと項目の字に混ざる。
       */
      if (tag === 'button' || tag === 'input' || tag === 'label') continue;
      if (el.classList.contains('pkc-md-copy-btn')) continue;
      if (RUN_BREAK_TAGS.has(tag)) breakRun(out, style);
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
      /**
       * 🔴 **数式は「打った字」を書く**(#707)。
       *
       * ⚠ **中へ降りてはいけない** ── KaTeX の出力は
       *   **MathML(CSS で隠す)と見た目用の span** の 2 本立てなので、
       *   素直に走査すると **同じ式が 2 回、しかも 1 文字ずつ崩れて** Word に入る。
       *   ⚠ しかも `skippedName` はこの形を知らないので**理由も出ない** ──
       *   「黙って壊れる」側である(着地前調査 2026-09-06 で判明)。
       * 🔑 器は原文(TeX)を持っているので、**それをそのまま書く**。
       *   ⚠ 「写せませんでした」にしない ── 打った字が残るほうが損が小さく、
       *   Word 側で式に組み直す材料にもなる(PKC2 の docx 書き出しと同じ判断)。
       * ⚠ **属性の名前は 1 か所で持つ**(`FIGURE_ATTR` と同じ戒め)。
       */
      const mathSrc = el.getAttribute(MATH_ATTR);
      if (mathSrc !== null && mathSrc !== '') {
        pushRun(out, mathText(el, mathSrc), { ...style, mono: true });
        continue;
      }
      const gone = skippedName(el);
      if (gone !== null) {
        skipped += 1;
        // ⚠ 段落の**中**に在った画像も、理由を文字として残す(黙って消さない)
        pushRun(out, `［${gone.what} は入れられませんでした: ${gone.why}］`, { ...style, italic: true });
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

  /** 項目の中で「字」ではなく独立した塊として出す子(コード枠・表・引用・見出し・図の器 …)。 */
  const isItemBlock = (el: Element): boolean => {
    const t = el.tagName.toLowerCase();
    return (
      t === 'pre' || t === 'table' || t === 'blockquote' || t === 'hr' || t === 'details' || t === 'div' ||
      headingLevel(t) !== null || figureOf(el) !== null ||
      el.classList.contains('pkc-render-slot') || el.getAttribute(MATH_ATTR) !== null
    );
  };

  /** 箇条書き(入れ子は `depth` で平らにする)。 */
  const walkList = (list: Element, depth: number, ordered: boolean): void => {
    for (const li of Array.from(list.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      /**
       * 🔴 **項目の中の入れ子の箇条書きと、コード枠・表などの塊は、項目の字から外す**。
       * 外さないと親の行に子の文字が混ざる / コードや表が 1 行に潰れる。
       * 外した物は**その項目の後ろへ、元の順に**別の塊として出す。
       */
      const kids = Array.from(li.children);
      const clone = li.cloneNode(true) as Element;
      const cloneKids = Array.from(clone.children);
      const later: Element[] = [];
      kids.forEach((k, i) => {
        const t = k.tagName.toLowerCase();
        if (t === 'ul' || t === 'ol' || isItemBlock(k)) {
          later.push(k);
          cloneKids[i]?.remove();
        }
      });
      const runs = runsOf(clone);
      if (runs.length > 0 || later.length === 0)
        blocks.push({ kind: 'li', ordered, depth, runs });
      for (const sub of later) {
        const t = sub.tagName.toLowerCase();
        if (t === 'ul' || t === 'ol') walkList(sub, depth + 1, t === 'ol');
        else {
          const holder = doc.createElement('div');
          holder.appendChild(sub.cloneNode(true));
          walkBlocks(holder);
        }
      }
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
       * (実測: ふつうのコードブロックでも 1 つ入っていた)。
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
        /**
         * 🔴 **引用の中も、引用の外と同じ規則で降りる**(段落だけを拾うと、段落が 1 つでも在る引用では
         * 箇条書き・コード・入れ子の引用・見出しが黙って消える)。
         * ⚠ 引用は入れ子を持たない塊なので、字を持つ塊(段落・見出し)を `quote` に**置き換える**
         * (添字が狂わないよう、その場で差し替える)。箇条書き・コード・表は元の塊のまま、引用の中の順に並ぶ。
         */
        if (el.children.length === 0) {
          blocks.push({ kind: 'quote', runs: runsOf(el) });
          continue;
        }
        const from = blocks.length;
        walkBlocks(el);
        for (let i = from; i < blocks.length; i++) {
          const b = blocks[i]!;
          if (b.kind === 'p') blocks[i] = { kind: 'quote', runs: b.runs };
          else if (b.kind === 'h')
            blocks[i] = { kind: 'quote', runs: b.runs.map((r) => ({ ...r, bold: true })) };
        }
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
        /**
         * 🔴 **改頁は水平線ではない**(#187 段③)。`+++` / `:::break` は
         * `hr.pkc-section-break` になり、**紙では `break-after: page`** が効く。
         * ⚠ `hr` と同じに畳むと、画面と紙では改頁なのに **Word でだけ線**になる。
         */
        blocks.push(el.classList.contains('pkc-section-break') ? { kind: 'pagebreak' } : { kind: 'hr' });
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
      /**
       * 🔴 **塊の数式も「打った字」で書く**(#707)── 理由は上の走りと同じ
       *   (KaTeX の 2 本立てを素通りさせると、同じ式が 2 回崩れて入る)。
       * ⚠ **段落 1 つ**にする(中央寄せは Word 側の書式なので、ここでは持たない)。
       */
      const blockMath = el.getAttribute(MATH_ATTR);
      if (blockMath !== null && blockMath !== '') {
        blocks.push({ kind: 'p', runs: [{ text: mathText(el, blockMath), mono: true }] });
        continue;
      }
      const gone = skippedName(el);
      if (gone !== null) {
        skipped += 1;
        blocks.push({ kind: 'skipped', ...gone });
        continue;
      }
      /**
       * 🔴 **自由配置の板**(#530 段①)。位置(`x=` / `y=`)を**印として**残し、
       * 中身はこれまでどおり後ろへ写す。
       *
       * ⚠ **中へ降りるより先に**拾う ── 降りてしまうと、位置がどこにも残らず
       * 「置いたとおりに並べた板が、縦に並んだ字」になる(いまがそれである)。
       * 🔑 印だけなので **Word の出力は 1 バイトも変わらない**(`docx.ts` の
       * `place` は何も出さない)。使うのは PowerPoint 側だけ。
       * ⚠ **入れ子にしない** ── `images` / `figures` が持つ添字が狂うため
       * (`docx.ts` の `place` の注記)。
       */
      /**
       * 🔴 **線の宣言は、中身ごと捨てる**(#530 段③a。着地前レビューが実測で出した)。
       *
       * ⚠ `.pkc-line` は**読む画面では `display: none`** なので、そこに字を書いても
       *   **画面には 1 文字も出ない**。ところが下の「知らない器は中へ降りる」に落ちると、
       *   その字が Word / PowerPoint に**普通の段落として突然出てくる**
       *   (実測: `[…, {p:"board A"}, …, {p:"混入したテキスト"}]`)。
       * 🔑 **画面に出ない物は、書き出しにも出さない** ── 見えない字が配る物にだけ
       *   現れるのは、user がいちばん気づけない壊れ方である。
       * ⚠ `.pkc-place` より**前**に見る ── 板の class を両方書いた塊は線として捨てる
       *   (位置を持つ線は在りえない)。
       */
      if (el.classList.contains('pkc-line')) {
        /**
         * 🔴 **中身は捨てるが、繋ぎ先は運ぶ**(#530 段③e)。
         * ⚠ 上の注記のとおり**字は 1 文字も運ばない**(`walkBlocks` を呼ばない)──
         *   運ぶのは `from=` / `to=` の名前だけである。
         * 🔑 綴りの解き方は `placeLineTargetId` の **1 本**(§7)── `a:right` の
         *   接続点つきの書き方も、板の名前だけを取り出せる。
         * ⚠ どちらか一方でも読めない線は**運ばない** ── 指す先が無い線を
         *   PowerPoint へ出すと、そこで**繋がっていない線**になる
         *   (画面では理由が出るが、配った先では出ない)。
         */
        const rawFrom = el.getAttribute('data-pkc-from');
        const rawTo = el.getAttribute('data-pkc-to');
        const from = placeLineTargetId(rawFrom);
        const to = placeLineTargetId(rawTo);
        /**
         * 🔑 **手で書いた接続点は、辺だけ運ぶ**(#530 段③b)。
         * ⚠ 読めない綴りは**運ばない**(`null`)── 画面は理由を出すが、
         *   配った先では出せないので、こちらで決めた辺に付く。
         */
        const spell = (raw: string | null): string | null => {
          const a = placeLineAnchorOf(raw);
          return a.kind === 'ok' ? anchorSpell(a.anchor) : null;
        };
        if (from !== null && to !== null) {
          // ⚠ 読めない綴りは運ばない(`null` = 既定のまっすぐ)── 画面は理由を出すが、
          //    配った先では出せないので、こちらで決めた形になる
          const r = parseRouteSpell(el.getAttribute('data-pkc-route'));
          const lineStroke = parsePlaceColor(el.getAttribute('data-pkc-stroke'));
          const lineWidth = parsePlaceWidth(el.getAttribute('data-pkc-width'));
          // 🔴 矢じり(#530)── 読む規則は画面と同じ 1 本(`placeArrowOf`)。⚠ 読めた `end` / `both` だけ運ぶ
          const lineArrow = placeArrowOf(el.getAttribute('data-pkc-arrow'));
          blocks.push({
            kind: 'place-line',
            from,
            to,
            fromAnchor: spell(rawFrom),
            toAnchor: spell(rawTo),
            route: r.kind === 'ok' ? r.route : null,
            // 🔴 色・太さ(#530 段④)── 読む規則は画面と同じ 1 本(`place-color.ts`)。
            // ⚠ **読めた物だけ運ぶ**(色なしの線の印は今までと 1 キーも変わらない)
            ...(lineStroke !== null ? { stroke: lineStroke } : {}),
            ...(lineWidth !== null ? { width: lineWidth } : {}),
            ...(lineArrow !== 'none' ? { arrow: lineArrow } : {}),
          });
        }
        continue;
      }
      if (el.classList.contains('pkc-place')) {
        const at = blocks.length;
        // ⚠ 先に場所を取る(中身を写す前)── 後から `splice` すると添字が狂う
        blocks.push({
          kind: 'place', x: 0, y: 0, w: null, h: null, shape: 'rect', name: null, span: 0,
        });
        walkBlocks(el);
        const fill = parsePlaceColor(el.getAttribute('data-pkc-fill'));
        const stroke = parsePlaceColor(el.getAttribute('data-pkc-stroke'));
        // 🔴 文字の大きさ(#530 段⑤a)── 読む規則は画面と同じ 1 本(`placeSizeOf`)。標準は運ばない
        const size = placeSizeOf(el.getAttribute('data-pkc-size'));
        // 🔴 回転・グループ(#530 段⑤c・⑤e)── 読む規則は画面と同じ 1 本(`placeRotateOf` / `parsePlaceGroup`)。0 / 無しは運ばない
        const rotate = placeRotateOf(el.getAttribute('data-pkc-rotate'));
        const group = parsePlaceGroup(el.getAttribute('data-pkc-group'));
        blocks[at] = {
          kind: 'place',
          x: pxAttr(el, 'data-pkc-x') ?? 0,
          y: pxAttr(el, 'data-pkc-y') ?? 0,
          w: pxAttr(el, 'data-pkc-w'),
          h: pxAttr(el, 'data-pkc-h'),
          // 🔑 形の既定(札が無い / 知らない字 = 四角)は `placeShapeOf` の 1 か所(§7)
          shape: placeShapeOf(el.getAttribute('data-pkc-shape')),
          // 🔴 色(#530 段④)── 読む規則は画面と同じ 1 本。⚠ 読めた物だけ運ぶ(色なしは 1 キーも変わらない)
          ...(fill !== null ? { fill } : {}),
          ...(stroke !== null ? { stroke } : {}),
          ...(size !== 'standard' ? { size } : {}),
          ...(rotate !== 0 ? { rotate } : {}),
          ...(group !== null ? { group } : {}),
          /**
           * 🔴 **板の名前**(#530 段③e)── 線の繋ぎ先はこれで引く。
           * ⚠ 名前の無い板は `null`(`id=""` は「書いていない」と同じ)。
           */
          name: el.id === '' ? null : el.id,
          span: blocks.length - at - 1,
        };
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
