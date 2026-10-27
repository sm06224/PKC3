/**
 * 🔴 **手元の画像を、アプリの目印にする**(#856 段③。user 指示 2026-10-26「全部やるのです」)。
 *
 * 段②(リンク先の印を取り込む)で作った器(`attachment.app_icon_asset_key` + 借りた絵を返す帳簿)を、
 * そのまま使う。違うのは**取りに行く相手が、通信ではなく user が選んだ file** なところだけ。
 *
 * ## 決めたこと(どれも段②と同じ向き)
 *
 * - **どのタイルでも使える** ── URL のタイルにも、登録した HTML のアプリにも。(🟣 段②の最後に出した 2 案のうち、
 *   「このノートに付いている画像から選ぶ」は URL のタイルでは候補が無く使えないので採らず、
 *   「画像を選んで取り込む」を採った。同じ絵を別のタイルにも使いたいときは、選び直す手数が増えるが、
 *   取り込み先の添付は中身の hash で 1 つにまとまる。)
 * - **通信しない** ── 外部画像の設定(常にオフ)の門は要らない。選んだ瞬間に端末の中で完結する。
 * - **画像でなければ受けない・大きすぎれば受けない**(`ICON_FILE_MAX_BYTES`)。理由を user の言葉で 1 行返す。
 * - **ノートには書かない** ── 鍵を返すだけ(書込の門を迂回しない。段②と同じ)。
 * - **整理(未参照の GC)と排他にする**(`AssetGate`)── 置いたばかりの bytes を消されないため。
 *
 * ⚠ `main.ts` へ判断を書かない(あそこは原文を読む test しか持てない ── CLAUDE.md §2)。
 */
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import { humanBytes } from '@features/human-bytes';
import type { AssetGate } from './asset-gate';
import { storeAsset, type AttachDeps } from './attach';
import type { AdoptLinkIconOutcome } from './adopt-favicon';

/** 目印に使う画像の大きさの上限(バイト)。⚠ 目印は 24px ほどで描く ── 数 MB の写真を端末に置くのは手違い。 */
export const ICON_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** 取り込んだ画像の名乗り。⚠ 添付の一覧に**何の絵か**が出る。 */
export const ICON_FILE_PREFIX = 'アプリのアイコン';

export interface AdoptIconFileDeps {
  readonly gate: AssetGate;
  readonly attach: AttachDeps;
}

/** 選んだ file を置く。⚠ 例外を投げず、結果で返す(`adoptLinkIcon` と同じ形)。 */
export async function adoptIconFile(
  deps: AdoptIconFileDeps,
  file: Pick<File, 'name' | 'type' | 'size'> & Blob,
): Promise<AdoptLinkIconOutcome> {
  if (file.size === 0) return { ok: false, why: '空のファイルです' };
  if (!isImageAssetMime(file.type)) return { ok: false, why: '画像ではありません(png・jpg・svg・webp などを選んでください)' };
  if (file.size > ICON_FILE_MAX_BYTES) {
    return {
      ok: false,
      why: `大きすぎます(${humanBytes(file.size)}。${humanBytes(ICON_FILE_MAX_BYTES)}までです)`,
    };
  }
  // ⚠ 箱に入れて受ける(`adoptLinkIcon` と同じ理由: 閉包の代入は tsc が見ない)
  const out: { assetKey: string | null; failed: string | null } = { assetKey: null, failed: null };
  await deps.gate(async () => {
    try {
      const stored = await storeAsset(deps.attach, {
        name: `${ICON_FILE_PREFIX} ${file.name}`,
        type: file.type,
        size: file.size,
        blob: file,
      });
      out.assetKey = stored.assetKey;
    } catch (e) {
      // ⚠ 空き容量が足りない等は**投げてくる** ── user が読める 1 行へ直す
      out.failed = e instanceof Error ? e.message : String(e);
    }
  });
  if (out.assetKey !== null) return { ok: true, assetKey: out.assetKey };
  return {
    ok: false,
    why: out.failed ?? 'いま別の処理が動いているので、少し待ってからもう一度選んでください',
  };
}
