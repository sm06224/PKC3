/**
 * DuckDB wasm 一式の**取得**(#682 段③a)。
 *
 * 同一オリジンの base から `pack.json`(目録)→ 実体を**1 つずつ** fetch する。
 * 🔑 Office(`office-pack-acquire.ts`)と同じ形(取得元は同一オリジンのみ / 404 を
 * 沈黙で通さない)を写すが、**中身は違う** ── zip の手動取り込み・gzip・
 * ビルドの素性は無い(#682 段③a の指示。この回では作らない)。
 *
 * ⚠ **検めるのは既に在る pure 層**(`@features/query/duckdb-pack.ts`)。目録の形・
 * 下限バイト・必須 file の判定はそこに 1 か所だけ在る ── ここで同じ判定を
 * 書き直さない(CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。
 */
import {
  DUCKDB_REQUIRED_FILES,
  duckDbAssetUrl,
  readDuckDbPack,
  type DuckDbPack,
} from '@features/query/duckdb-pack';

export class DuckDbPackAcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuckDbPackAcquireError';
  }
}

export interface AcquireProgress {
  (phase: string, done: number, total: number): void;
}

/** 取ってきた実体。保管側へはこの形で渡す。 */
export type DuckDbPackFiles = Map<string, Blob>;

/**
 * 取得元の**目録**(`pack.json`)を読む。
 *
 * 🔑 これが在るので、この層は「一式とは何か」を 1 つも知らなくてよい ──
 * 判定はまるごと `readDuckDbPack`(pure)に在る。
 * ⚠ **JSON として読めた**を「目録だった」と読まない ── 形は `readDuckDbPack` が見る
 * (404 の HTML を Pages が返す設定もありうるので、沈黙を成功と読まない)。
 */
/**
 * 🔴 **取得元が同一オリジンであることを、ここで断る**(#682 段③a、2026-09-15)。
 *
 * ⚠ `duckDbAssetUrl`(pure)は**ただの文字列の連結**で、外の宛先も組めてしまう ──
 *   にもかかわらず、その docstring は長らく「外の宛先を組める形にしない」と
 *   **守っていない物を守っていると書いていた**。🔑 だから**本物の門をここへ置く**。
 * ⚠ **基点は `document.baseURI`**(相対 path を解決する本来の API)── `location` の
 *   字を読むと `tests/features/flags.test.ts` の「クエリを読んでいないか」の全数検査に
 *   掛かる(Office の `resolveBase` と同じ理由)。
 * 🔑 断り文は**なぜ駄目か**まで言う ── 別 origin は CORS で必ず失敗するので、
 *   「設定が違う」ではなく「その道は無い」と伝える。
 */
export function resolveDuckDbBase(base: string, baseURI: string = document.baseURI): string {
  const root = new URL(base, baseURI);
  if (root.origin !== new URL(baseURI).origin) {
    throw new DuckDbPackAcquireError(
      `取得元は同じ場所(origin)でなければなりません(指定: ${root.origin})。`
        + '別の場所は CORS で必ず失敗するので、その道はありません。',
    );
  }
  return root.href.endsWith('/') ? root.href : `${root.href}/`;
}

export async function fetchDuckDbPackManifest(base: string): Promise<DuckDbPack> {
  const url = duckDbAssetUrl(resolveDuckDbBase(base), 'pack.json');
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new DuckDbPackAcquireError(`取得元に届きません: ${url}`);
  }
  if (!res.ok) {
    throw new DuckDbPackAcquireError(`取得元に一式がありません(HTTP ${res.status}): ${url}`);
  }
  const parsed = readDuckDbPack(await res.text());
  if (!parsed.ok) throw new DuckDbPackAcquireError(parsed.why);
  return parsed.pack;
}

/**
 * 同一オリジンから、目録が指す file を**1 つずつ**取る。
 *
 * 🔑 **何を取るかは `DUCKDB_REQUIRED_FILES`(pure)が持つ** ── ここで名前を
 *   並べ直さない。⚠ #682 段④b で **2 → 5** になったが、並べていたら
 *   **拡張だけ端末に入らない**(そして「入れたのに parquet が読めない」に化ける)。
 *
 * 🔴 **取った実体の大きさが目録と食い違ったら断る**(出力が届いたかを見る検査 ──
 * 目録を検める入力側の検査とは別物)。ネットワークの途中切断や、キャッシュの
 * 古い残骸を「取れた」と言わないため。
 */
export async function fetchDuckDbPackFiles(
  base: string,
  pack: DuckDbPack,
  onProgress?: AcquireProgress,
): Promise<DuckDbPackFiles> {
  const names = DUCKDB_REQUIRED_FILES;
  const out: DuckDbPackFiles = new Map();
  for (const [i, name] of names.entries()) {
    onProgress?.(`取得中: ${name}`, i, names.length);
    // ⚠ **1 file ごとに門を通す** ── ここだけ素の `base` を使うと、門が片側にしか無くなる
    const url = duckDbAssetUrl(resolveDuckDbBase(base), name);
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new DuckDbPackAcquireError(`取得元に届きません: ${url}`);
    }
    // ⚠ **沈黙を成功と読まない。** 404 の HTML を掴んで「入った」と言わない
    if (!res.ok) throw new DuckDbPackAcquireError(`取得できません: ${name}(HTTP ${res.status})`);
    const blob = await res.blob();
    const want = pack.files.find((f) => f.path === name)?.bytes;
    if (want !== undefined && blob.size !== want) {
      throw new DuckDbPackAcquireError(
        `${name} の大きさが目録と違います(目録 ${want} byte / 実際 ${blob.size} byte。取り直してください)`,
      );
    }
    out.set(name, blob);
  }
  onProgress?.('検査中', names.length, names.length);
  return out;
}

/**
 * 目録を読んでから実体を取る、まとめ口。`duckdb-pack-install.ts` はここだけを呼ぶ。
 *
 * 🔴 **別オリジンは `resolveDuckDbBase()` が断る**(この file の上)。
 * ⚠ 直す前のここには「`duckDbAssetUrl` が組むから別 origin を渡す道は無い」と
 *   書いてあったが、**それは事実ではなかった** ── あちらは文字列を繋ぐだけである。
 */
export async function fetchDuckDbPackFromBase(
  base: string,
  onProgress?: AcquireProgress,
): Promise<{ readonly files: DuckDbPackFiles; readonly version: string }> {
  // ⚠ **目録の取得そのものは刻まない**(Office の `fetchPackManifest` と同じ ── 数百
  //   バイトなので刻む意味が無い)。「取り掛かった」ことを伝える 1 行は呼び側
  //   (`duckdb-pack-install.ts`)が持つ ── ここは file の取得だけを刻む。
  const pack = await fetchDuckDbPackManifest(base);
  const files = await fetchDuckDbPackFiles(base, pack, onProgress);
  return { files, version: pack.version };
}
