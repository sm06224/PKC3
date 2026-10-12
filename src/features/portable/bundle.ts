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
export function checkImageParts(marks: readonly string[]): string | null {
  if (marks.length === 0) return null;
  if (marks.length === 1 && marks[0] === '') return null; // 割る前の版の 1 本物
  for (let i = 0; i < marks.length; i++) {
    const m = PART_MARK_RE.exec(marks[i]!);
    if (m === null || Number(m[1]) !== i || Number(m[2]) !== marks.length) {
      return `DB の中身が ${marks.length} 個に分かれて入っていますが、${i + 1} 個目の番号が合いません(途中で切れた・混ざったファイルかもしれません)`;
    }
  }
  return null;
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
 * @throws 途中の要素が `IMAGE_PART_BYTES` ちょうどでない / 空の部分がある / base64 でない
 */
export function decodeImageParts(reads: ReadonlyArray<() => string>): Uint8Array | null {
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
  const put = (text: string, at: number, limit: number): number => {
    let off = at;
    for (let i = 0; i < text.length; i += DECODE_STEP) {
      const bin = atob(text.slice(i, i + DECODE_STEP));
      if (off + bin.length > limit) throw new Error('中身が想定の大きさを超えています');
      for (let j = 0; j < bin.length; j++) out[off++] = bin.charCodeAt(j);
    }
    return off - at;
  };
  for (let k = 0; k < n - 1; k++) {
    const text = stripSpace(reads[k]!().trim());
    // 🔴 途中の要素は**ちょうど** `IMAGE_PART_BYTES`。短い・長い要素を黙って詰めると、後ろが前へずれて別の画像になる
    if (text.length !== IMAGE_PART_CHARS) {
      throw new Error(
        `DB の中身の ${k + 1} 個目が途中で欠けています(想定 ${IMAGE_PART_CHARS} 字、実際 ${text.length} 字)`,
      );
    }
    put(text, k * IMAGE_PART_BYTES, (k + 1) * IMAGE_PART_BYTES);
  }
  put(last, (n - 1) * IMAGE_PART_BYTES, out.length);
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
