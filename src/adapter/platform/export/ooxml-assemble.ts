/**
 * OOXML(`.docx` / `.pptx`)の**組み立てと zip**(#187 段④・段⑤)。
 *
 * ⚠ **ここに `self` を触る処理を書かない。** この module は **worker と主スレッドの
 * 両方**から読まれる(ワーカーが使えない環境の落とし所)── 主スレッドで
 * `self.onmessage` を差すと、**window の message を横取りする**ことになる。
 * ワーカーの口は `ooxml-worker.ts` が持つ。
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
 *
 * ## 🔴 なぜ Word と PowerPoint を 1 つの module に置くのか(#187 段⑤)
 *
 * ⚠ **同じ仕事を 2 か所に置かない**(CLAUDE.md §7)。ワーカーへ逃がす規律も、
 * ワーカーが無いときの落とし所も、**bytes を zip のどこへ置くかも**まったく同じで、
 * 違うのは「どの組み立て器を呼ぶか」だけである。分けると**片方だけ直す事故**が起きる。
 * 🔑 常駐するワーカーも **1 本**で済む(user 指示 2026-08-03 の「使い捨てにする」)。
 */
import { buildDocx, type DocxBlock, type DocxResult } from '@features/export/docx';
import { buildPptx, type PptxResult } from '@features/export/pptx';
import { ZipWriter } from '@features/export/zip-writer';
import type { PageFormat } from '@features/page-format';

/**
 * zip に足す bytes。
 *
 * 🔴 **名前は「形式の根からの相対」**(`media/image1.png`)である ── zip のどこへ
 * 置くか(`word/` か `ppt/`)を決めるのは**ここ**であって、呼び側ではない。
 * ⚠ これを呼び側に決めさせると、**rels が指す先**(`docx.ts` / `pptx.ts` が書く)と
 * **bytes を置く場所**が別々の file で決まる ── 片方だけ直すと
 * 「rels は在るのに絵が出ない」という**静かに壊れる**形になる。
 */
export interface OoxmlMedia {
  name: string;
  blob: Blob;
}

/** 1 件の依頼。⚠ **DOM を渡さない**(塊まで畳んでから来る)。 */
export type OoxmlJob =
  | {
      kind: 'docx';
      blocks: DocxBlock[];
      title: string;
      iso: string;
      pageFormat: PageFormat;
      media: OoxmlMedia[];
    }
  | {
      kind: 'pptx';
      blocks: DocxBlock[];
      title: string;
      media: OoxmlMedia[];
    };

/** 返り。⚠ zip は Blob のまま返す(開かない)。 */
export interface OoxmlJobResult {
  blob: Blob;
  warnings: readonly string[];
  /** ⚠ 形式ごとに項目が違う(docx は塊と画像、pptx は枚数も)。 */
  counts: DocxResult['counts'] | PptxResult['counts'];
}

/** worker が返す形。⚠ `ooxml-worker.ts` と `worker-lease.ts` が読む。 */
export interface OoxmlJobResponse {
  id: number;
  ok: boolean;
  result?: OoxmlJobResult;
  error?: string;
}

/** bytes を置く根。⚠ **rels が指す先と対**である(上の `OoxmlMedia` の注意)。 */
const MEDIA_ROOT = { docx: 'word', pptx: 'ppt' } as const;

/**
 * 組み立て → zip。⚠ **ワーカーの外(同期の落とし所)からも呼ぶ**ので、
 * ここに `self` を触る処理を書かない ── 出口を 2 本にしないための形である
 * (`markdown-client.ts` が同じ理由で `renderMarkdown` を直に呼ぶのと同じ)。
 */
export async function assembleOoxml(req: OoxmlJob): Promise<OoxmlJobResult> {
  const built =
    req.kind === 'docx'
      ? buildDocx(req.blocks, req.title, req.iso, req.pageFormat)
      : buildPptx(req.blocks, { title: req.title });
  const zip = new ZipWriter();
  for (const part of built.parts) await zip.add(part.name, [part.text]);
  for (const m of req.media) await zip.add(`${MEDIA_ROOT[req.kind]}/${m.name}`, [m.blob]);
  return { blob: zip.finish(), warnings: built.warnings, counts: built.counts };
}
