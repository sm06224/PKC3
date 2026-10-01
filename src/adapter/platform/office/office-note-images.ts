/**
 * Office の「挿入 → 画像」に並べる**候補を、ノートから引く**(#146 裁定 A)。
 *
 * 🔑 「ノートに付いている添付」= **そのノートの本文が `asset:` で使っている添付**
 * (右の列の「添付」の行と同じ読み手 `listAssetUses`)。PKC3 の添付は
 * ノートの子ではなく**単独のノート**で、ノートとの結びつきは本文の参照だけである。
 *
 * 🔴 **`main.ts` に書かない。** あそこは原文を読む test しか無い面で、判断を置くと
 * 全 tests 緑のまま取り違える(`office-open.ts` と同じ理由)。
 *
 * ⚠ **bytes はここで読まない。** 返すのは大きさまで ── 上限で落とす物を読む必要は無い
 * (`pickOfficeImages` が選んだ分だけ、呼び側が読む)。
 * ⚠ **投げない。** 引けない 1 件のために、残りの画像まで並ばなくなってはならない。
 */
import { listAssetUses } from '../../../features/asset/asset-refs-in-body';
import { readAttachmentMeta } from '../../../features/flavor/attachment-flavor';
import {
  isOfficeImageMime,
  type OfficeImageCandidate,
} from '../../../features/office/office-images';

export interface NoteImageDeps {
  /** ノートの本文。読めなければ null。 */
  readonly getBody: (lid: string) => Promise<string | null>;
  /** その添付(key)を持つ**添付ノートの lid**。無ければ null(整理済みなど)。 */
  readonly findOwner: (assetKey: string) => Promise<string | null>;
  /** bytes は読まずに、大きさと種類だけ。無ければ null。 */
  readonly blobInfo: (assetKey: string) => Promise<{ size: number; type: string } | null>;
}

/**
 * 本文が使っている画像を、候補にして返す。
 *
 * @param lids 引く元のノート(重複・空は無視する)。⚠ 同じ key は 1 件にする
 */
export async function listNoteImages(
  deps: NoteImageDeps,
  lids: readonly (string | null | undefined)[],
): Promise<OfficeImageCandidate[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const lid of new Set(lids.filter((l): l is string => typeof l === 'string' && l !== ''))) {
    let body: string | null;
    try {
      body = await deps.getBody(lid);
    } catch {
      body = null;
    }
    if (body === null) continue;
    for (const u of listAssetUses(body)) {
      if (seen.has(u.key)) continue;
      seen.add(u.key);
      keys.push(u.key);
    }
  }

  const one = async (key: string): Promise<OfficeImageCandidate | null> => {
    try {
      const info = await deps.blobInfo(key);
      if (info === null) return null;
      const t = info.type.split(';')[0]!.trim().toLowerCase();
      // ⚠ 画像でないと**はっきり分かる**物は、持ち主を引かずに外す(zip や docx を N 往復で引かない)
      if (t !== '' && t !== 'application/octet-stream' && !isOfficeImageMime(t)) return null;
      const owner = await deps.findOwner(key);
      let name = '';
      let mime = info.type;
      if (owner !== null) {
        const meta = readAttachmentMeta((await deps.getBody(owner)) ?? '');
        name = meta.name;
        // ⚠ 添付ノートの mime は拡張子から引いた値(取り込みの `resolveMime`)── Blob の種類が空でも当たる
        if (meta.mime !== 'application/octet-stream') mime = meta.mime;
      }
      if (!isOfficeImageMime(mime)) return null;
      return { key, name, mime, size: info.size };
    } catch {
      return null;
    }
  };
  const got = await Promise.all(keys.map(one));
  return got.filter((c): c is OfficeImageCandidate => c !== null);
}
