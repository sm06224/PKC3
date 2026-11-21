/**
 * 🔴 **差分ファイルに入れるノートを 1 件ずつ取り出す(本文の取得だけ呼び手が渡す)**。
 *
 * 主スレッド(差分ファイルの書き出し)と storage worker(フォルダ同期の差分ファイルの組み立て)が**同じ 1 本**を使う
 * (同じ判定を 2 か所に生やさない)。本文は 200 件ずつ取り、heap に全件を溜めない。運ぶ添付の目録(`carried`)は、本文が参照する物を数えながら溜める。
 * ⚠ pure module。
 */
import { assetRefsIn } from '../asset/asset-ref-scan';
import type { DiffAssetMeta, DiffNote } from './diff-file';

export interface DiffNoteMeta {
  title: string;
  archetype: string;
  parentLid: string | null;
}

export interface DiffNoteSource {
  lids: readonly string[];
  metaByLid: ReadonlyMap<string, DiffNoteMeta>;
  /** 本文を引く(無い lid は出さない)。 */
  fetchBodies(lids: string[]): Promise<ReadonlyArray<{ lid: string; body: string }>>;
  /** 添付の目録(`size` / `hash` は NULL がありうる)。 */
  assetMetas: ReadonlyArray<{ key: string; mime: string | null; size: number | null; hash: string | null }>;
  /** 本文が参照する添付がここへ溜まる(呼び手が書き終えた後に読む)。 */
  carried: Map<string, DiffAssetMeta>;
}

export const DIFF_NOTE_BATCH = 200;

export async function* diffNoteStream(src: DiffNoteSource): AsyncGenerator<DiffNote> {
  const assetKeys = src.assetMetas.map((a) => a.key);
  const byKey = new Map(src.assetMetas.map((a) => [a.key, a] as const));
  for (let i = 0; i < src.lids.length; i += DIFF_NOTE_BATCH) {
    const rows = await src.fetchBodies(src.lids.slice(i, i + DIFF_NOTE_BATCH));
    for (const r of rows) {
      const m = src.metaByLid.get(r.lid);
      if (m === undefined) continue;
      for (const k of assetRefsIn(r.body, assetKeys)) {
        const a = byKey.get(k);
        if (a !== undefined && !src.carried.has(k)) src.carried.set(k, { key: k, mime: a.mime ?? 'application/octet-stream', size: a.size ?? 0, hash: a.hash });
      }
      yield { lid: r.lid, title: m.title, archetype: m.archetype, parentLid: m.parentLid, body: r.body };
    }
  }
}
