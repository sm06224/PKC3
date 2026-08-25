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
      ? { use: 'embedded', why: '器がまだ空なので、配られた中身を開きます' }
      : { use: 'fresh', why: '新しい器を作ります' };

  /**
   * ⚠ **別のバンドルの記録が返ってきたら、それは器の名前空間が壊れている合図**である。
   * 🔑 落とさず、**配られた側を採る**(他人の記録の上に書かない)。
   */
  if (stored.bundleId !== bundle.id)
    return hasEmbedded
      ? { use: 'embedded', why: '器に別のバンドルの記録があるので、配られた中身を開きます' }
      : { use: 'fresh', why: '器に別のバンドルの記録があるので、新しい器を作ります' };

  if (stored.bytes <= 0)
    return hasEmbedded
      ? { use: 'embedded', why: '器の記録が空だったので、配られた中身を開きます' }
      : { use: 'fresh', why: '器の記録が空だったので、新しい器を作ります' };

  if (!hasEmbedded) return { use: 'stored', why: 'この端末に保存された中身を開きます' };

  /**
   * 🔴 **ここが本題** ── 同じ id の HTML を**新しく書き出して置き直した**とき。
   * 器に何も書いていなければ(`savedAt < exportedAt`)、配られたほうが新しい。
   */
  return stored.savedAt >= bundle.exportedAt
    ? { use: 'stored', why: 'この端末で編集した中身のほうが新しいので、そちらを開きます' }
    : { use: 'embedded', why: '配られた中身のほうが新しいので、そちらを開きます' };
}
