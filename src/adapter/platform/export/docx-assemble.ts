/**
 * Word(.docx)の**組み立てと zip**(#187 段④)。
 *
 * ⚠ **ここに `self` を触る処理を書かない。** この module は **worker と主スレッドの
 * 両方**から読まれる(ワーカーが使えない環境の落とし所)── 主スレッドで
 * `self.onmessage` を差すと、**window の message を横取りする**ことになる。
 * ワーカーの口は `docx-worker.ts` が持つ。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行を
 * > バッファして、ワーカーにディスパッチします」
 *
 * ## なぜ「組み立てと zip」だけなのか(測ってから決めた)
 *
 * 実測(実ブラウザ・294KB の本文・対照群は同じ文書の閲覧用 HTML 書き出し):
 *
 * | 段 | 実測 | ワーカーへ動かせるか |
 * |---|---|---|
 * | 本文を HTML にする | 既にワーカー | ✅ 済 |
 * | HTML を **parse** する | 71ms | ❌ **DOM はワーカーに無い** |
 * | 塊へ**走査**する | 58ms | ❌ 同上 |
 * | **OOXML の組み立て + zip** | 残り(合計の詰まりは 354ms) | ✅ **ここ** |
 *
 * 🔑 だから「全部ワーカーへ」ではなく、**動かせる所を動かす**。
 * ⚠ 塊(`DocxBlock[]`)は素の object なので構造化複製で渡せる。画像・図の bytes は
 * **Blob のまま**渡す ── Blob の複製は**中身をコピーしない**(参照が移るだけ)。
 * ⚠ 返すのも Blob 1 個。ここで `arrayBuffer()` に開くと、**heap に載る**
 * (2026-07-27 の不可侵指示「ゼロコピー / 生成物は寿命終端で即破棄」に反する)。
 */
import { buildDocx, type DocxBlock, type DocxResult } from '@features/export/docx';
import { ZipWriter } from '@features/export/zip-writer';
import type { PageFormat } from '@features/page-format';

/** 1 件の依頼。⚠ **DOM を渡さない**(塊まで畳んでから来る)。 */
export interface DocxJob {
  blocks: DocxBlock[];
  title: string;
  iso: string;
  pageFormat: PageFormat;
  /** zip に足す bytes(`word/media/*`)。⚠ Blob のまま渡す。 */
  media: Array<{ name: string; blob: Blob }>;
}

/** 返り。⚠ zip は Blob のまま返す(開かない)。 */
export interface DocxJobResult {
  blob: Blob;
  warnings: readonly string[];
  counts: DocxResult['counts'];
}

/** worker が返す形。⚠ `docx-worker.ts` と `worker-lease.ts` が読む。 */
export interface DocxJobResponse {
  id: number;
  ok: boolean;
  result?: DocxJobResult;
  error?: string;
}

/**
 * 組み立て → zip。⚠ **ワーカーの外(同期の落とし所)からも呼ぶ**ので、
 * ここに `self` を触る処理を書かない ── 出口を 2 本にしないための形である
 * (`markdown-client.ts` が同じ理由で `renderMarkdown` を直に呼ぶのと同じ)。
 */
export async function assembleDocx(req: DocxJob): Promise<DocxJobResult> {
  const built = buildDocx(req.blocks, req.title, req.iso, req.pageFormat);
  const zip = new ZipWriter();
  for (const part of built.parts) await zip.add(part.name, [part.text]);
  for (const m of req.media) await zip.add(m.name, [m.blob]);
  return { blob: zip.finish(), warnings: built.warnings, counts: built.counts };
}
