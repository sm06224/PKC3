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
 * ## 段① で写さないもの(黙って落とさない)
 *
 * - **画像**(添付 / 図の PNG)は段② ── `skipped` として**その場に理由を出す**
 * - `<iframe>`(html fence の箱)/ `<svg>` も同じ扱い
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
    return {
      what: alt !== '' ? `画像「${alt}」` : '画像',
      why: 'この版では画像を Word に入れていません',
    };
  }
  if (tag === 'svg') return { what: '図(ベクタ)', why: 'この版では図を Word に入れていません' };
  if (tag === 'iframe') return { what: '埋め込みの箱', why: 'Word では動きません' };
  if (tag === 'canvas') return { what: '描画の面', why: 'Word では動きません' };
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
} {
  const blocks: DocxBlock[] = [];
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
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
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
  return { blocks, skipped };
}
