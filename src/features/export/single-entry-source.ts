/**
 * P6f: **1 ノートだけのアーカイブ**。
 *
 * user 指示 2026-08-02:
 * 「そういうのは削除じゃなくて**アーカイブエクスポートの導線**を用意すればいいのでは?」
 *
 * ── ゴミ箱の版を復元できるようにするのではなく、**消す前に書き出せる場所**を
 * 用意するのが正しい形。ゴミ箱を往復させる機構(削除済み lid の写像)は
 * P6c review H-1 で事故が実証されている危険地帯で、そこを避けられる。
 *
 * 実装は `ArchiveSource` を**絞り込むだけ**。writer(`writeArchive`)も
 * 読み戻し(`restoreArchive`)も既存のまま使う ── 形式が増えないので、
 * 「1 ノート用の書出しだけ壊れている」が起きようがない。
 */
import type { ArchiveSource } from './pkc3-archive';

/**
 * 添付 key らしき token。⚠ **raw 走査**でよい(`asset-gc.ts` と同じ規律)──
 * 誤差は false-keep 側にしか出ない(無関係な散文が key を偶然含む)。
 *
 * 🔑 **逆向きパッチの中も走査できる**。パッチは「古い版の行」を*挿入する*形で
 * 持つので、途中の版だけが参照していた添付も文字列として現れる。
 * materialize しなくても取りこぼさない。
 */
const KEYISH = /[A-Za-z0-9_.-]*ast-[A-Za-z0-9_.-]+/g;

export interface SingleEntryResult {
  source: ArchiveSource;
  /** 書き出せなかったもの(呼び出し側が注意として出す)。 */
  warnings: string[];
}

/**
 * 1 件の entry だけを含む `ArchiveSource` を作る。
 *
 * @throws entry が居ないときは断る(空のアーカイブを作らない)
 */
export async function singleEntrySource(
  base: ArchiveSource,
  lid: string,
): Promise<SingleEntryResult> {
  const warnings: string[] = [];
  const metas = await base.listEntryMetas();
  const meta = metas.find((m) => m.lid === lid);
  if (!meta) throw new Error('書き出す entry が見つかりません');

  // 本文は 1 件ぶんだけ引く(全 entry を舐めない)
  let body: string | null = null;
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await base.listBodies(after, 4 * 1024 * 1024);
    const hit = rows.find((r) => r.lid === lid);
    if (hit) {
      body = hit.body;
      break;
    }
    if (done || !next) break;
    if (
      after !== undefined &&
      !(next.entryOrder > after.entryOrder ||
        (next.entryOrder === after.entryOrder && next.lid > after.lid))
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }
  if (body === null) throw new Error('書き出す entry の本文を読めませんでした');

  const chain = (await base.listRevisionLids()).includes(lid)
    ? await base.getRevisionChain(lid)
    : [];

  // ── この entry が**かつて 1 度でも**参照した添付を集める
  const used = new Set<string>();
  const scan = (text: string): void => {
    KEYISH.lastIndex = 0;
    for (let m = KEYISH.exec(text); m; m = KEYISH.exec(text)) used.add(m[0]);
  };
  scan(body);
  for (const r of chain) scan(r.snapshot);

  // ── 関連は**落ちる**(相手の entry がこのアーカイブに居ない)。黙って落とさない
  const relations = await base.listRelations();
  const touching = relations.filter((r) => r.from_lid === lid || r.to_lid === lid);
  if (touching.length > 0) {
    warnings.push(`このノートに繋がる関連 ${touching.length} 件は含まれません(相手のノートが入らないため)`);
  }

  const allAssets = await base.listAssetMetas();
  const assets = allAssets.filter((a) => used.has(a.key));

  return {
    warnings,
    source: {
      cid: base.cid,
      // 題名は entry のもの ── ファイル名がそのままノート名になる
      title: meta.title || lid,
      listEntryMetas: async () => [meta],
      listBodies: async () => ({ rows: [{ lid, body: body! }], done: true }),
      // ⚠ 端点が片方しか居ない関連は復元側が捨てて警告する ── ここでは出さない
      listRelations: async () => [],
      listAssetMetas: async () => assets,
      getAssetBlob: (key) => base.getAssetBlob(key),
      listRevisionLids: async () => (chain.length > 0 ? [lid] : []),
      getRevisionChain: async () => chain,
    },
  };
}
