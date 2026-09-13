/**
 * 🔴 **リンク先の印(favicon)を探す**(#856 段②)。
 *
 * ## 何のためにこの file が在るか
 *
 * user 裁定 2026-09-13(こちらの解釈)── **通信は user が押した瞬間だけ**にしたうえで、
 * 取れる率を上げたい。だから **2 段構え**にする:
 *
 * 1. まずサイトの**決まった場所**を 1 回見る(通信 1 回で済むサイトが多い)
 * 2. 🔴 **そこに無かったときだけ**、そのページを読んで、サイトが**自分で指している**印を探す
 *
 * ⚠ 「押していないのに通信しない」という裁定の目的は、どちらの段でも守られている。
 *
 * ## ここに置いた理由(層)
 *
 * 🔑 **判断だけをここに置く** ── `fetch` はしない(adapter の仕事)。
 * ⚠ ページを読む側は `Document` を受け取る形にした ── `html-to-markdown.ts` が
 *   `DOMParser` を注入可能にしているのと同じ作法で、**worker にも node にも
 *   `DOMParser` は無い**(そして test から実物を当てられる)。
 */

/** 印を 1 つ。⚠ **なぜ選んだか**まで返す(選ばれ方が読めないと、後から検算できない)。 */
export interface IconPick {
  /** 取りに行く先(絶対 URL)。 */
  readonly url: string;
  /** 宣言されていた大きさ(px)。`null` = 書いていない。⚠ `any`(ベクタ)は `Infinity`。 */
  readonly size: number | null;
  /** `rel` に何と書いてあったか(そのまま)。 */
  readonly rel: string;
}

/** 取りに行ってよい入れ物か。⚠ `data:` は**通信が 1 度も起きない**ので受ける。 */
function isFetchableScheme(u: URL): boolean {
  return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'data:';
}

/**
 * 🔴 **決まった場所**(段 1)。`https://example.com/a/b` → `https://example.com/favicon.ico`。
 *
 * ⚠ **ページの path を捨てて、サイトの根から引く** ── これがこの場所の決まりである。
 * ⚠ 読めない綴り / `http(s)` でない綴りには `null`(呼び側に「段 1 は無い」と言う)。
 */
export function wellKnownIconUrl(pageUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return null;
  }
  // ⚠ `data:` のページは根を持たない ── 段 1 が成り立たない
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  /**
   * ⚠ **`new URL('/favicon.ico', …)` と書かない。**
   *
   * 配る量の検品(`scripts/dist-inspect.mjs`)は **`new URL(…)` の構文**で
   * 「配置場所を根に決め打ちした参照」を拾う ── PKC3 は `base: './'` に全面的に
   * 依存していて、`/` 決め打ちが 1 件でも在ると **`/dev/` やセルフホストで 404** になる
   * (#532 S1)。⚠ その門は**こちらの生成物**を守るためのもので、
   * **他所のサイトの根**を指すここは対象外である ── だが構文では見分けられない。
   * 🔑 だから**意味どおりに書く**:これは「相対 path を base で解く」のではなく
   *   「**その origin + この path**」である(結果は 1 文字も変わらない ──
   *   `URL.origin` は末尾に `/` を持たない)。
   */
  return `${base.origin}/favicon.ico`;
}

/**
 * 🔴 `sizes` を数にする。`"32x32"` → 32 / `"16x16 32x32"` → 32 / `"any"` → `Infinity`。
 *
 * ⚠ **大きいほうを採る** ── 一覧に出すのは小さい枠だが、**縮めるのは足す側でできる**。
 *   逆(小さいものを引き伸ばす)は戻せない。
 */
function sizeOf(sizes: string): number | null {
  const words = sizes.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return null;
  let best: number | null = null;
  for (const w of words) {
    if (w === 'any') return Infinity;
    const m = /^(\d+)x(\d+)$/.exec(w);
    if (m === null) continue;
    const n = Math.min(Number(m[1]), Number(m[2]));
    if (best === null || n > best) best = n;
  }
  return best;
}

/**
 * 🔴 **そのページが指している印を全部拾う**(段 2)。
 *
 * ⚠ 拾うのは `rel` に **`icon`**(`shortcut icon` もこれで当たる)か
 *   **`apple-touch-icon`** を持つ `<link>` だけ。
 * ⚠ **`<base href>` を見る** ── 見ないと、相対の綴りが**別の場所**を指す
 *   (ページ自身が「この文書の基点はここ」と言っているのを無視することになる)。
 * ⚠ 並べ替えは**大きい順、同じなら文書の順**。⚠ `sizes` を書いていないものは
 *   **末尾**へ回す(書いてある物のほうが、サイトの意図が読める)。
 */
export function iconPicksFromDocument(doc: Document, pageUrl: string): IconPick[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  // ⚠ `<base href>` は**読めたときだけ**効かせる(読めない綴りで全部落とさない)
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href') ?? null;
  if (baseHref !== null) {
    try {
      base = new URL(baseHref, base);
    } catch {
      /* 読めない `<base>` は無かったことにする */
    }
  }

  const out: Array<IconPick & { order: number }> = [];
  const links = doc.querySelectorAll('link[rel]');
  for (let i = 0; i < links.length; i += 1) {
    const el = links[i]!;
    const rel = el.getAttribute('rel') ?? '';
    const tokens = rel.trim().toLowerCase().split(/\s+/);
    if (!tokens.includes('icon') && !tokens.includes('apple-touch-icon')) continue;
    const href = el.getAttribute('href') ?? '';
    if (href.trim() === '') continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!isFetchableScheme(url)) continue;
    out.push({
      url: url.href,
      size: sizeOf(el.getAttribute('sizes') ?? ''),
      rel,
      order: i,
    });
  }

  out.sort((a, b) => {
    // ⚠ 書いていない物は末尾(`null` を 0 として混ぜると、書いてある 16px より先に来る)
    const as = a.size ?? -1;
    const bs = b.size ?? -1;
    if (as !== bs) return bs - as;
    return a.order - b.order;
  });
  return out.map(({ url, size, rel }) => ({ url, size, rel }));
}
