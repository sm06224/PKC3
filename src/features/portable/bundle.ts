/**
 * 🔴 **可搬単一 HTML の「どの器を使うか」**(#400 段③)。
 *
 * ## なぜ純粋層に置くのか
 *
 * `file://` では **origin が全部 `file://` に潰れる**(2026-08-25 実測。#400)──
 * 別ディレクトリの別 HTML 同士で IndexedDB が**共有される**。だから
 * 「どの器に書くか」を間違えると、**その端末の可搬バンドル全部が互いを上書きする**。
 * ⚠ これは「あると良い」ではなく**正しさの要件**である。
 *
 * 🔑 判定は 1 か所に置く(CLAUDE.md §7)── 器の名前・鍵の名前・放送路の名前は
 * **同じ id から導く**。3 か所で別々に組み立てると、1 つだけ名前空間を切り忘れる。
 */

/** 焼き込まれた印。`<script type="application/json" data-pkc-bundle>` の中身。 */
export interface PortableBundle {
  /** このバンドル固有の id。器 / 鍵 / 放送路の名前空間になる。 */
  readonly id: string;
  /** 書き出した時刻(epoch ms)。「器の DB が配られた画像より新しいか」の材料。 */
  readonly exportedAt: number;
}

/**
 * 🔴 **id に許す字は狭くする。**
 *
 * この値は **IndexedDB の器の名前・Web Locks の鍵の名前**になる ── どちらも
 * 任意の文字列を受けるので、**壊れた値でも動いてしまう**(そして 2 つの
 * バンドルが同じ名前に落ちても誰も鳴らない)。
 * ⚠ だから受け口で狭める。⚠ 上限も置く ── 器の名前に本文が丸ごと入る形を作らない。
 */
const ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function isBundleId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/**
 * 焼き込まれた JSON を読む。**読めなければ `null`**(= 可搬バンドルではない)。
 *
 * ⚠ **`null` は「素の PKC3」と同じ意味**である ── 通常の配信(`https://`)には
 * この印が無いので、ここが `null` を返す限り**既存の経路は 1 バイトも変わらない**。
 * 🔑 それを `tests/features/portable-bundle.test.ts` が pin している。
 */
export function parseBundleTag(text: string | null | undefined): PortableBundle | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, exportedAt } = raw as { id?: unknown; exportedAt?: unknown };
  if (!isBundleId(id)) return null;
  // ⚠ 時刻は「数である」だけでは足りない ── NaN / Infinity / 負は比較を壊す
  if (typeof exportedAt !== 'number' || !Number.isFinite(exportedAt) || exportedAt < 0)
    return null;
  return { id, exportedAt };
}

/** IndexedDB の器の名前。⚠ `file://` ではこれだけがバンドルを分ける。 */
export function bundleDbName(id: string): string {
  return `pkc3-bundle-${id}`;
}

/** 書込リースの鍵。⚠ `file://` では鍵の名前空間も共有なので切る。 */
export function bundleLockName(id: string): string {
  return `pkc3-writer-${id}`;
}

/** タブ間の放送路。⚠ 切らないと**別のバンドルのタブ**が互いを holder と見なす。 */
export function bundleChannelName(id: string): string {
  return `pkc3-store-proxy-${id}`;
}

/**
 * sqlite 側の器の名前(OPFS SAHPool の pool 名)。
 *
 * ⚠ `file://` では OPFS が取れないので効かないが、**同じ HTML を `https://` に
 * 置いたとき**に効く ── 素の PKC3 と同じ `pkc3` を使うと、**配ったバンドルが
 * その origin の本体の DB を開く**。
 */
export function bundleSqliteName(id: string): string {
  return `pkc3-${id}`;
}

/**
 * 🔴 **DB 画像は 1 本の `<script>` に入れず、この大きさごとの `<script>` に割る**(#1416 §7-4)。
 *
 * HTML の読み手は `<script>` の中身を**1 つの Text node へ継ぎ足しながら**読む。実測(Chromium、
 * 乱数の base64 を `file://` で開くだけの対照): **1 本で 60MB → 2.3 秒 / 120MB → 7.6 秒 /
 * 240MB → 27.7 秒**(倍にすると 3.3〜3.6 倍 = 二乗)。**4MB ごとに割ると 1.0 / 2.0 / 3.9 秒**
 * (大きさに比例)。割る単位は 1〜16MB で差が無く、64MB で二乗が戻り始める。
 * 🔑 3 の倍数(元 bytes)なので、途中の要素に `=` が出ず、**各要素を独立に復号できる**。
 */
export const IMAGE_PART_BYTES = 3 * 1024 * 1024;

/**
 * 割った要素の印(`data-pkc-db-image` の値)。`<番号>/<総数>` ── 番号は 0 から。
 * ⚠ 値が**空**なのは、割る前の版が書いた 1 本物(今も開ける)。
 */
export function imagePartMark(index: number, count: number): string {
  return `${index}/${count}`;
}

const PART_MARK_RE = /^(\d{1,9})\/(\d{1,9})$/;

/**
 * 要素の並び(文書の順)に付いた印が、1 つの画像として揃っているかを見る。
 * @param marks `data-pkc-db-image` の値を文書の順に並べたもの(属性が無ければ呼ばない)
 * @returns 揃っていれば `null`、欠け・重複・順の乱れ・形の違いがあれば理由(画面に出せる字)
 */
export function checkImageParts(marks: readonly string[], label = 'DB の中身'): string | null {
  if (marks.length === 0) return null;
  if (marks.length === 1 && marks[0] === '') return null; // 割る前の版の 1 本物
  for (let i = 0; i < marks.length; i++) {
    const m = PART_MARK_RE.exec(marks[i]!);
    if (m === null || Number(m[1]) !== i || Number(m[2]) !== marks.length) {
      return `${label}が ${marks.length} 個に分かれて入っていますが、${i + 1} 個目の番号が合いません(途中で切れた・混ざったファイルかもしれません)`;
    }
  }
  return null;
}

/**
 * 添付の要素の並び(文書の順)を、**1 件ずつの塊**に分ける(#1416 §7-4d)。
 *
 * 添付も DB 画像と同じく `IMAGE_PART_BYTES` ごとに割って焼く。割った添付の要素は
 * `data-pkc-asset-part="<番号>/<総数>"` を持ち、**同じ key が続く**。値の無いものは割る前の版が焼いた 1 本物
 * (1 要素 = 1 件)。起動(`portable-assets.ts`)と取り込み(`import/portable-html.ts`)が**同じ規則**で塊にする。
 * @param items 文書の順の (key, 印)。印は `data-pkc-asset-part` の値(無ければ空)
 * @returns 塊ごとの { start, count, broken }。`broken` は揃っていない理由(揃っていれば `null`)
 */
export function groupAssetParts(
  items: ReadonlyArray<{ readonly key: string; readonly mark: string }>,
): Array<{ start: number; count: number; broken: string | null }> {
  const out: Array<{ start: number; count: number; broken: string | null }> = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    if (first.mark === '') {
      out.push({ start: i, count: 1, broken: null });
      i++;
      continue;
    }
    // 同じ key で印のある要素が続く間が、この塊の候補
    let run = 1;
    while (i + run < items.length && items[i + run]!.key === first.key && items[i + run]!.mark !== '') run++;
    const m = PART_MARK_RE.exec(first.mark);
    // 先頭が 0/N なら、総数 N までを取る(余りは次の塊 = 先頭が 0 でないので断られる)
    const total = m !== null && Number(m[1]) === 0 ? Number(m[2]) : run;
    const count = Math.max(1, Math.min(run, total));
    const marks = items.slice(i, i + count).map((x) => x.mark);
    out.push({
      start: i,
      count,
      broken: checkImageParts(marks, `添付「${first.key}」の中身`) ?? (count < total ? '途中で切れています' : null),
    });
    i += count;
  }
  return out;
}

/** 1 要素に入る base64 の字数(`IMAGE_PART_BYTES` の 4/3)。 */
export const IMAGE_PART_CHARS = (IMAGE_PART_BYTES / 3) * 4;

/** 一度に `atob` に渡す字数。⚠ 4 の倍数(途中で割っても各塊が単独で復号できる)。 */
const DECODE_STEP = 4 * 262144;

const stripSpace = (t: string): string => (/\s/.test(t) ? t.replace(/\s+/g, '') : t);

/**
 * 割って焼いた DB 画像を、**1 本の `Uint8Array` へ直に復号する**(#1416 §7-4)。
 *
 * 🔴 **中間の塊を作らない** ── 要素ごとに復号した物を貯めて最後に繋ぐと、画像の約 2 倍 +
 *   base64 の文字列が同時に居る(実測前の見積もりで画像の約 3.3 倍)。ここは
 *   ① 最後の要素だけ先に読んで総 bytes を決める(最後だけ端数と `=` が出る)
 *   ② 1 本を確保し、各要素を**自分の置き場へ直に**書く
 *   ③ 読んだ文字列は呼び側が `read()` の中で手放す(この関数は貯めない)
 * @param reads 文書の順に、各要素の base64 を返す口(⚠ 呼ぶのは 1 回ずつ。最後の要素だけ先に呼ぶ)
 * @returns 全部空なら `null`(割る前の版の空の要素 = 画像なし)
 * @param label 断り文に出す名前(添付なら「添付「key」の中身」)
 * @throws 途中の要素が `IMAGE_PART_BYTES` ちょうどでない / 空の部分がある / base64 でない
 */
export function decodeImageParts(
  reads: ReadonlyArray<() => string>,
  label = 'DB の中身',
): Uint8Array | null {
  const n = reads.length;
  if (n === 0) return null;
  const last = stripSpace(reads[n - 1]!().trim());
  if (last === '') {
    if (n === 1) return null;
    throw new Error('割られた中身のうち空の部分があります');
  }
  const pad = last.endsWith('==') ? 2 : last.endsWith('=') ? 1 : 0;
  const lastBytes = (last.length / 4) * 3 - pad;
  if (!Number.isInteger(lastBytes) || lastBytes <= 0) throw new Error('base64 の長さが合いません');
  const out = new Uint8Array((n - 1) * IMAGE_PART_BYTES + lastBytes);
  const put = (text: string, at: number, limit: number): number => putBase64(out, text, at, limit);
  for (let k = 0; k < n - 1; k++) {
    const text = stripSpace(reads[k]!().trim());
    // 🔴 途中の要素は**ちょうど** `IMAGE_PART_BYTES`。短い・長い要素を黙って詰めると、後ろが前へずれて別の画像になる
    if (text.length !== IMAGE_PART_CHARS) {
      throw new Error(
        `${label}の ${k + 1} 個目が途中で欠けています(想定 ${IMAGE_PART_CHARS} 字、実際 ${text.length} 字)`,
      );
    }
    put(text, k * IMAGE_PART_BYTES, (k + 1) * IMAGE_PART_BYTES);
  }
  put(last, (n - 1) * IMAGE_PART_BYTES, out.length);
  return out;
}

/** `text`(空白を除いた base64)を `out[at..limit)` へ復号して書く。書いた bytes 数を返す。 */
function putBase64(out: Uint8Array, text: string, at: number, limit: number): number {
  let off = at;
  for (let i = 0; i < text.length; i += DECODE_STEP) {
    const bin = atob(text.slice(i, i + DECODE_STEP));
    if (off + bin.length > limit) throw new Error('中身が想定の大きさを超えています');
    for (let j = 0; j < bin.length; j++) out[off++] = bin.charCodeAt(j);
  }
  return off - at;
}

/**
 * 1 要素の base64 を**復号せずに**測った形(#1416)。窓で読む取り込みが、辿りの間(字を持っている間)に採る。
 * 復号は確認の後まで遅らせるが、**壊れ方の判定は遅らせない**(確認の前に断る文が変わらないように)。
 */
export interface Base64Shape {
  /** 空白を除いた字数。 */
  readonly chars: number;
  /** 末尾の `=` の数(0〜2)。 */
  readonly pad: number;
  /** `atob` が受ける形か(`=` は末尾の 2 字までで、字数が合う)。 */
  readonly ok: boolean;
}

export function shapeOfBase64(raw: string): Base64Shape {
  const t = stripSpace(raw.trim());
  const pad = t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0;
  return shapeOfCounts(t.length, pad, t.indexOf('='));
}

/** 字数・末尾の `=` の数・最初の `=` の位置(空白を除いた並びでの。無ければ -1)から形を決める。⚠ 字で測る方・bytes で測る方が同じ 1 つを通る。 */
export function shapeOfCounts(chars: number, pad: number, firstEq: number): Base64Shape {
  // atob(forgiving-base64): `=` は末尾の 2 字までで、あるなら字数が 4 の倍数。残りの字数が 4 で割って 1 余るものは受けない
  const ok = (firstEq === -1 || firstEq === chars - pad) && (pad === 0 ? chars % 4 !== 1 : chars % 4 === 0);
  return { chars, pad, ok };
}

/**
 * `decodeImageParts` が**断る場面**を、復号せず形だけで先に判定する(#1416)。断る文・断る順番は同じ。
 * @returns 復号後の総 bytes。全部空(割る前の版の空の要素)なら `null`
 * @throws `decodeImageParts` が投げるものと同じ文(`atob` が断る形は文の無い `Error('base64')` ── 呼び側が一般の文へ言い換える)
 */
export function checkImageShapes(shapes: readonly Base64Shape[], label = 'DB の中身'): number | null {
  const n = shapes.length;
  if (n === 0) return null;
  const last = shapes[n - 1]!;
  if (last.chars === 0) {
    if (n === 1) return null;
    throw new Error('割られた中身のうち空の部分があります');
  }
  const lastBytes = (last.chars / 4) * 3 - last.pad;
  if (!Number.isInteger(lastBytes) || lastBytes <= 0) throw new Error('base64 の長さが合いません');
  for (let k = 0; k < n - 1; k++) {
    const s = shapes[k]!;
    if (s.chars !== IMAGE_PART_CHARS) {
      throw new Error(`${label}の ${k + 1} 個目が途中で欠けています(想定 ${IMAGE_PART_CHARS} 字、実際 ${s.chars} 字)`);
    }
    if (!s.ok) throw new Error('base64');
  }
  if (!last.ok) throw new Error('base64');
  return (n - 1) * IMAGE_PART_BYTES + lastBytes;
}

/**
 * 割った 1 要素(`k` 番目)を、**その要素だけ**の bytes へ復号する(#1416)。`checkImageShapes` を通った形が前提。
 * `bytes` はその要素が占める大きさ(途中は `IMAGE_PART_BYTES`、最後は端数)── 余った所は 0 のまま(`decodeImageParts` と同じ)。
 */
export function decodeImagePart(raw: string, bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  putBase64(out, stripSpace(raw.trim()), 0, bytes);
  return out;
}

// base64 の字 → 6 bit(字でなければ 255)
const B64_VALUE = (() => {
  const t = new Uint8Array(256).fill(255);
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) t[abc.charCodeAt(i)] = i;
  return t;
})();

/**
 * `decodeImagePart` の bytes 版 ── base64 の字(ASCII の bytes。**空白を含まない**)を、字にせず直に復号する(#1416)。
 * 数 MB の字を作って捨てると回収されないまま常駐するので、取り込みの道はこちらを使う。`checkImageShapes` を通った形が前提。
 * 末尾の `=` の扱い・短く復号した残りが 0 のままになる点は `decodeImagePart`(= `atob` を通る版)と同じ。
 */
export function decodeImagePartBytes(src: Uint8Array, bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let end = src.length;
  while (end > 0 && src[end - 1] === 0x3d && src.length - end < 2) end--;
  let o = 0;
  let i = 0;
  const full = end - (end % 4);
  for (; i < full; i += 4) {
    const n =
      (B64_VALUE[src[i]!]! << 18) | (B64_VALUE[src[i + 1]!]! << 12) | (B64_VALUE[src[i + 2]!]! << 6) | B64_VALUE[src[i + 3]!]!;
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = end - full; // 0 / 2 / 3(`=` を除いた残り)
  if (rest >= 2) {
    const n = (B64_VALUE[src[i]!]! << 18) | (B64_VALUE[src[i + 1]!]! << 12) | (rest === 3 ? B64_VALUE[src[i + 2]!]! << 6 : 0);
    out[o] = n >> 16;
    if (rest === 3) out[o + 1] = (n >> 8) & 255;
  }
  return out;
}

/** 器に入っている画像の目録(bytes は含めない ── 判定に要らない)。 */
export interface StoredImageMeta {
  readonly bundleId: string;
  /** その画像を作ったバンドルの `exportedAt`。 */
  readonly exportedAt: number;
  /** 最後に器へ書いた時刻。 */
  readonly savedAt: number;
  /** 画像の大きさ。0 は「空の器」── 中身が無いものを採らないための門。 */
  readonly bytes: number;
}

export type ImageSource = 'stored' | 'embedded' | 'fresh';

export interface ImageChoice {
  readonly use: ImageSource;
  /** なぜそれを選んだか。⚠ 状態行と test の両方が読む(黙って決めない)。 */
  readonly why: string;
}

/**
 * 🔴 **器の DB と、配られた画像の、どちらを開くか**(設計 doc §4-3 の裁定 C)。
 *
 * > ⚠ どちらでも、**器に入っている DB が「配られた画像より新しい」場合は器を優先する**
 * > (上書きすると user の編集が消える)。
 *
 * 🔑 判定材料は **`savedAt` と `exportedAt` の 2 つだけ**。bytes は見ない
 * (大きさは新しさを表さない ── 消した結果ちぢむこともある)。
 * ⚠ ただし **0 バイトの器は採らない** ── 書込が途中で落ちた残骸を
 * 「user の最新」として開くと、**配られた中身ごと空になる**。
 */
export function chooseImage(args: {
  bundle: PortableBundle;
  stored: StoredImageMeta | null;
  /** 焼き込まれた画像の大きさ(0 / 無しなら「空から始める」)。 */
  embeddedBytes: number;
}): ImageChoice {
  const { bundle, stored, embeddedBytes } = args;
  const hasEmbedded = embeddedBytes > 0;

  if (stored === null)
    return hasEmbedded
      ? { use: 'embedded', why: 'このブラウザにはまだ保存されたノートが無いので、この HTML ファイルに埋め込まれた中身を開きます' }
      : { use: 'fresh', why: 'このブラウザにはまだ保存されたノートが無いので、新しく始めます' };

  /**
   * ⚠ **別のバンドルの記録が返ってきたら、それは器の名前空間が壊れている合図**である。
   * 🔑 落とさず、**配られた側を採る**(他人の記録の上に書かない)。
   */
  if (stored.bundleId !== bundle.id)
    return hasEmbedded
      ? { use: 'embedded', why: 'このブラウザに保存されているのは別の PKC3 入り HTML のノートなので、この HTML ファイルに埋め込まれた中身を開きます' }
      : { use: 'fresh', why: 'このブラウザに保存されているのは別の PKC3 入り HTML のノートなので、新しく始めます' };

  if (stored.bytes <= 0)
    return hasEmbedded
      ? { use: 'embedded', why: 'このブラウザに保存されているノートが空なので、この HTML ファイルに埋め込まれた中身を開きます' }
      : { use: 'fresh', why: 'このブラウザに保存されているノートが空なので、新しく始めます' };

  if (!hasEmbedded) return { use: 'stored', why: 'この端末に保存された中身を開きます' };

  /**
   * 🔴 **ここが本題** ── 同じ id の HTML を**新しく書き出して置き直した**とき。
   * 器に何も書いていなければ(`savedAt < exportedAt`)、配られたほうが新しい。
   */
  return stored.savedAt >= bundle.exportedAt
    ? { use: 'stored', why: 'この端末で編集した中身のほうが新しいので、そちらを開きます' }
    : { use: 'embedded', why: 'この HTML ファイルに埋め込まれた中身のほうが新しいので、そちらを開きます' };
}
