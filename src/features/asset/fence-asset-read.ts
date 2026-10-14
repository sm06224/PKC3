/**
 * 🔴 **囲みが指している添付を、字として読む**(#444 段①/段②)。
 *
 * 🔑 **読み方の規則を 1 本にする**(CLAUDE.md §7)── 読む人は 2 人いる:
 *   - **画面**(`detail.ts` の hydrator)── 器を後から埋める
 *   - **書き出し**(`pkc3-html.ts` / `export-archive.ts`)── その場で焼き込む
 *   別々に書くと、**片方だけ上限が効かない / 断り文が違う**が静かに起きる。
 *
 * ⚠ ここは bytes を触るので `core` には置けない。⚠ 逆に DOM は 1 行も触らない
 *   ので adapter にも置かない ── 入口は「鍵 → Blob」の口 1 つだけである。
 */

/** 添付 1 件の読み。⚠ 失敗は**理由つき**で返す(黙って空にしない)。 */
export type FenceAssetRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

/** 鍵 → bytes。⚠ 無ければ `null`(投げてもよい ── ここで受ける)。 */
export type FenceAssetBlobSource = (key: string) => Promise<Blob | null>;

/**
 * 1 件読む。
 * ⚠ **大きさで断らない**(#492。user 指示 2026-08-27)── かつて 2MB を超えると
 *   読まずに理由を出していたが、**user が置いた物を開けないほうが害が大きい**。
 */
export async function readFenceAssetText(
  getBlob: FenceAssetBlobSource,
  key: string,
): Promise<FenceAssetRead> {
  let blob: Blob | null;
  try {
    blob = await getBlob(key);
  } catch {
    // ⚠ 投げた = 無いと決まったわけではない(保存領域を開けなかった等)── 「見つかりません」と
    //   言うと user は消えたと思う。読み直せば開くことがある
    return { ok: false, why: 'その添付を読み込めませんでした(もう一度開いてください)' };
  }
  if (!blob) return { ok: false, why: 'その添付が見つかりません' };
  try {
    const text = await blob.text();
    // 🔴 `Blob.text()` は binary でも投げない(壊れた字に化けるだけ)── 画像・zip を
    //   字として並べないよう、字の種類でない物が NUL / 置換文字を含むときは断る
    if (!isTextualMime(blob.type ?? '') && (text.includes('\u0000') || text.includes('\uFFFD'))) {
      return { ok: false, why: '字として読めません' };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, why: '字として読めません' };
  }
}

/**
 * 字のファイルとして扱う種類。⚠ 種類が空・見慣れない物は「字ではない」とは決めない
 * (中身の NUL / 置換文字で別に見る)── 変わった種類名の本物の字ファイルを断らないため。
 */
export function isTextualMime(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m.startsWith('text/')) return true;
  return /(^|[/+.-])(json|xml|csv|javascript|ecmascript|yaml|toml|sql|x-sh|ndjson|markdown|svg)($|[+.-])/.test(m);
}

/**
 * 🔴 **書き出しのために、鍵の束をまとめて読む**(#444 段②)。
 *
 * ⚠ 読めなかったものは**束に入れない** ── 描く側が器のまま理由を出すので、
 *   「持ち出したら中身が空だった」にはならない。⚠ 代わりに `onSkip` で
 *   **書き出しの注意へ積む**(黙って落とさない)。
 */
export async function readFenceAssets(
  getBlob: FenceAssetBlobSource,
  keys: readonly string[],
  onSkip?: (key: string, why: string) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const got = await readFenceAssetText(getBlob, key);
    if (got.ok) out[key] = got.text;
    else onSkip?.(key, got.why);
  }
  return out;
}
