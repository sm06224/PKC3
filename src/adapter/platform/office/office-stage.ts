/**
 * 🔴 **Office の窓が置いた bytes を引き取る**(#205 段 B / 方式監査 #209 の **B2**)。
 *
 * ⚠ **置く側はここに居ない。** `public/office/office-save-stage.js`(素の JS)が置く ──
 * 別 realm・別 process なので、共有できるのは**棚の名前と file の綴りだけ**である。
 * だから `tests/adapter/office-stage.test.ts` が**両方の file を読んで**突き合わせる
 * (CLAUDE.md §7「同じ値が複数の場所にある」)。
 *
 * ## なぜ中継が要るのか(B4)
 *
 * 🔴 **sqlite の `assets` 行を書けるのは writer リースを持つタブだけ**である
 * (OPFS SAHPool は実質単一接続 ── `../storage/writer-lease.ts`)。
 * **Office の窓は絶対に書けない。** bytes は窓が置き、meta の確定はリース保持タブが
 * やる ── 「あった方がよい中継」ではなく **2 相コミット**である。
 *
 * ## 🔴 引き取りは **at-least-once**(取り違えると文書が消える)
 *
 * OPFS に transaction は無いので、「読んだら消える」を原子的には書けない。
 * 2 通りのうち**どちらを選ぶかで、事故の向きが逆になる**:
 *
 * | 順序 | 途中で落ちると |
 * |---|---|
 * | 先に消す(at-most-once) | **保存が消える**(user は保存したつもり) |
 * | **後で消す(at-least-once)** | ノートが 2 件できることがある(user は消せる) |
 *
 * → **後で消す**を採る。⚠ 二重取りは「holder(writer リース保持タブ)だけが引き取る」で
 * 実運用上は起きず、残るのは**落ちた時の重複**だけ ── **消せる事故**を選ぶ。
 *
 * ## 置き方(素の JS 側と対)── `.bin` を先、`.json` を後
 *
 * `<鍵>.json` が在ることが「完全に置けた」の印である。したがって:
 * - `.json` と `.bin` が揃っている = 引き取ってよい
 * - `.bin` だけ = **書きかけ**。⚠ **すぐ消してはいけない**(いま書いている最中かもしれない)
 *   → `sweepStagedOrphans` が**猶予**を過ぎたものだけ消す
 */

/** 🔴 棚の名前。⚠ `public/office/office-save-stage.js` の `STAGE_DIR` と同じ綴り。 */
export const OFFICE_STAGE_DIR = 'pkc3-office-stage';

/** meta の版。⚠ 置く側の `STAGE_META_VERSION` と同じ値。 */
export const OFFICE_STAGE_META_VERSION = 1;

/**
 * 書きかけを消すまでの猶予。⚠ **書いている最中の `.bin` を消さない**ための値なので、
 * 「いちばん大きい文書を刻んで書き切る時間」より**十分長く**採る。
 */
export const STAGE_ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** 窓が置いた 1 件。⚠ bytes は入っていない(別 file)。 */
export interface StagedSave {
  readonly key: string;
  readonly name: string;
  /**
   * LO の中での path。
   *
   * ⚠ **これ単独ではノートを同定しない**(2026-08-16 に注記を改めた。以前は
   * 「診断用」とだけ書いていたが、#217 で**同定の材料の一部**になった)。
   * 使うのは **`win` と対にした 1 回の引き取りの中だけ** ── 合言葉がまだ無い
   * 同じ文書の保存を束ねるために使う(`office-save-back.ts` の `sameDoc`)。
   * ⚠ 窓を跨いで path で同定してはいけない ── `/work/報告.odt` は**窓ごとに
   * 別の MEMFS に在る**ので、別の文書が同じ path を持ちうる。
   */
  readonly path: string;
  readonly size: number;
  readonly at: number;
  /** どのノートの添付だったか(`office-open.ts` が窓へ預けた合言葉)。無ければ新規。 */
  readonly token?: string;
  /**
   * 🔴 **どの窓が置いたか**(#217)。窓が起動のたびに 1 つ作る id。
   * ⚠ **`path` を同定に使うために要る** ── これが無いと、2 枚目の窓が同じ名前の
   * 文書を保存したときに**別の文書どうしを同じノートへ束ねる**。
   * ⚠ 古い窓が置いた meta には無い ── そのときは束ねない(安全側 = 別扱い)。
   */
  readonly win?: string;
}

/** OPFS の file(必要な分だけ。⚠ lib.dom の型に縛られない)。 */
interface StageFileHandle {
  getFile(): Promise<{
    size: number;
    lastModified: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }>;
}

/** OPFS の棚(必要な分だけ)。 */
export interface StageDir {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<StageFileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<{ kind: string; name: string }>;
}

/**
 * 棚を開く。⚠ **無い環境では `null`**(落とさない ── OPFS が無いだけで Office の窓を
 * 開けなくする理由が無い)。
 */
export async function openStageDir(storage?: {
  getDirectory(): Promise<{
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<StageDir>;
  }>;
}): Promise<StageDir | null> {
  const s =
    storage ??
    (globalThis.navigator as unknown as { storage?: typeof storage } | undefined)?.storage;
  if (!s || typeof s.getDirectory !== 'function') return null;
  try {
    const root = await s.getDirectory();
    return await root.getDirectoryHandle(OFFICE_STAGE_DIR, { create: true });
  } catch {
    // ⚠ private mode / 権限で開けないことがある ── 無い時と同じ扱いにする
    return null;
  }
}

function parseMeta(text: string): StagedSave | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  // ⚠ 知らない版は読まない(将来の形を勝手に解釈しない)
  if (r.v !== OFFICE_STAGE_META_VERSION) return null;
  if (typeof r.key !== 'string' || r.key === '') return null;
  if (typeof r.size !== 'number' || !(r.size > 0)) return null;
  return {
    key: r.key,
    name: typeof r.name === 'string' && r.name !== '' ? r.name : 'document',
    path: typeof r.path === 'string' ? r.path : '',
    size: r.size,
    at: typeof r.at === 'number' ? r.at : 0,
    ...(typeof r.token === 'string' && r.token !== '' ? { token: r.token } : {}),
    ...(typeof r.win === 'string' && r.win !== '' ? { win: r.win } : {}),
  };
}

/**
 * 揃っているものを古い順に並べる。
 * ⚠ **`.json` を起点にする**(それが「置き切った」の印であり、`.bin` は書きかけを含む)。
 */
export async function listStaged(dir: StageDir): Promise<StagedSave[]> {
  const names: string[] = [];
  for await (const e of dir.values()) {
    if (e.kind === 'file' && e.name.endsWith('.json')) names.push(e.name);
  }
  const out: StagedSave[] = [];
  for (const n of names) {
    let text: string;
    try {
      text = await (await (await dir.getFileHandle(n)).getFile()).text();
    } catch {
      continue; // ⚠ 引き取り中に消えることがある ── 競争は黙って譲る
    }
    const meta = parseMeta(text);
    // ⚠ 鍵と file 名が食い違うものは触らない(消す判断もしない ── 見なかったことにする)
    if (meta && `${meta.key}.json` === n) out.push(meta);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * bytes を読む。⚠ **消さない**(消すのは `discardStaged` ── 上の at-least-once)。
 * @returns 読めなければ `null`(消えていた / 大きさが meta と食い違う)
 */
// ⚠ 型引数を明示する ── 既定の `Uint8Array<ArrayBufferLike>` は `SharedArrayBuffer` を
//    含むので **`new Blob([bytes])` に渡せない**(この repo は COI 下なので実際に効く)
export async function readStaged(
  dir: StageDir,
  meta: StagedSave,
): Promise<Uint8Array<ArrayBuffer> | null> {
  let buf: ArrayBuffer;
  try {
    buf = await (await (await dir.getFileHandle(`${meta.key}.bin`)).getFile()).arrayBuffer();
  } catch {
    return null;
  }
  // 🔴 **大きさを突き合わせる。** 食い違うのは書きかけ ── 半端な文書でノートを
  //    上書きしたら、user の文書がそこで壊れる
  if (buf.byteLength !== meta.size) return null;
  return new Uint8Array(buf);
}

/** 引き取り終わったので捨てる。⚠ **冪等**(既に無くても落ちない)。 */
export async function discardStaged(dir: StageDir, key: string): Promise<void> {
  for (const suffix of ['.json', '.bin']) {
    try {
      await dir.removeEntry(key + suffix);
    } catch {
      // 既に無い ── 冪等
    }
  }
}

/**
 * 🔴 **書きかけの残骸だけを掃除する**(B5 の 3 つ目の入口 = 起動時)。
 *
 * ⚠ **揃っているものは消さない。** 引き取り損ねた保存は「遅れている」だけであり、
 * 消したら user の文書が黙って消える。消してよいのは
 * **`.json` を持たない `.bin` が、猶予を過ぎている**ときだけである。
 *
 * @returns 消した件数
 */
export async function sweepStagedOrphans(
  dir: StageDir,
  opts: { now?: () => number; graceMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? ((): number => Date.now());
  const grace = opts.graceMs ?? STAGE_ORPHAN_GRACE_MS;
  const bins: string[] = [];
  const metas = new Set<string>();
  for await (const e of dir.values()) {
    if (e.kind !== 'file') continue;
    if (e.name.endsWith('.bin')) bins.push(e.name);
    else if (e.name.endsWith('.json')) metas.add(e.name.slice(0, -'.json'.length));
  }
  let removed = 0;
  const t = now();
  for (const n of bins) {
    if (metas.has(n.slice(0, -'.bin'.length))) continue;
    let lastModified: number;
    try {
      lastModified = (await (await dir.getFileHandle(n)).getFile()).lastModified;
    } catch {
      continue;
    }
    // 🔑 いま書いている最中かもしれない ── 猶予を過ぎたものだけ消す
    if (t - lastModified < grace) continue;
    try {
      await dir.removeEntry(n);
      removed += 1;
    } catch {
      // 競争に負けた ── 誰かが消した
    }
  }
  return removed;
}
