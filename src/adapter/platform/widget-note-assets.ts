/**
 * 🔴 **ウィジェットの「このノートの添付から選ぶ」に並べる候補**(#2097)。
 *
 * 🔑 「このノートの添付」= **そのノートの本文が `asset:` で使っている添付**と、そのノートが添付ノートなら**そのファイル自身**。
 *   PKC3 の添付はノートの子ではなく単独のノートで、ノートとの結びつきは本文の参照だけである
 *   (Office の「挿入 → 画像」と同じ読み手 `listAssetUses`)。
 * 🔴 **他のノートの添付へ越境しない** ── 鍵は**親が読んだ本文**からだけ引く(箱が名乗った鍵は 1 つも使わない)。
 *
 * ⚠ bytes はここで読まない(候補は名前・種類・大きさだけ)。読むのは user が選んだ 1 件だけ(呼び側)。
 * ⚠ 投げない ── 引けない 1 件のために、残りの候補まで並ばなくなってはならない。
 */
import { listAssetUses } from '../../features/asset/asset-refs-in-body';
import { readAttachmentMeta } from '../../features/flavor/attachment-flavor';

export interface WidgetNoteAsset {
  readonly key: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export interface WidgetNoteAssetDeps {
  /** そのノートの本文(読めなければ `null`)。 */
  readonly bodyOf: (lid: string) => string | null;
  /** 添付の鍵 → 添付ノートのファイル名(引けなければ `null`)。 */
  readonly nameOf: (key: string) => Promise<string | null>;
  /** bytes を読まずに、大きさと種類だけ(無ければ `null`)。 */
  readonly blobInfo: (key: string) => Promise<{ size: number; type: string } | null>;
}

/** 1 回に並べる上限(本文に添付が何百あっても確認バーを埋め尽くさない)。 */
export const WIDGET_NOTE_ASSET_LIMIT = 50;

/** そのノートの添付の鍵(出てくる順・重複なし。添付ノート自身のファイルが先)。 */
export function widgetNoteAssetKeys(body: string): string[] {
  const keys: string[] = [];
  const own = readAttachmentMeta(body).assetKey;
  if (own !== null && own !== '') keys.push(own);
  for (const u of listAssetUses(body)) if (!keys.includes(u.key)) keys.push(u.key);
  return keys.slice(0, WIDGET_NOTE_ASSET_LIMIT);
}

export async function listWidgetNoteAssets(deps: WidgetNoteAssetDeps, lid: string): Promise<WidgetNoteAsset[]> {
  let body: string | null;
  try {
    body = deps.bodyOf(lid);
  } catch {
    body = null;
  }
  if (body === null) return [];
  const own = readAttachmentMeta(body);
  const one = async (key: string): Promise<WidgetNoteAsset | null> => {
    try {
      const info = await deps.blobInfo(key);
      if (info === null) return null;
      const name = (own.assetKey === key && own.name !== '' ? own.name : await deps.nameOf(key)) ?? '';
      const type = info.type.split(';')[0]!.trim();
      const mime = type !== '' ? type : own.assetKey === key ? own.mime : 'application/octet-stream';
      return { key, name: name === '' ? key : name, mime, size: info.size };
    } catch {
      return null;
    }
  };
  const got = await Promise.all(widgetNoteAssetKeys(body).map(one));
  return got.filter((a): a is WidgetNoteAsset => a !== null);
}

/**
 * 🔴 **「このノートへ添付」が本当に効いたか**(レビュー指摘)── `attachFiles` は断り・失敗を知らせで言って正常に終わる。
 * 添付ノートが増えた、または(同じ中身の添付を使い回した回)そのノートの本文の添付の参照が増えたときだけ `true`。
 * @param refsBefore / refsAfter そのノートの本文の添付の参照の数(本文が読めなければ `-1`)
 */
export function widgetAttachLanded(
  lidsBefore: ReadonlySet<string>,
  metasAfter: ReadonlyMap<string, { readonly archetype: string }>,
  refsBefore: number,
  refsAfter: number,
): boolean {
  for (const [lid, m] of metasAfter) if (!lidsBefore.has(lid) && m.archetype === 'attachment') return true;
  return refsBefore >= 0 && refsAfter > refsBefore;
}
