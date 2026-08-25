/**
 * 🔴 **可搬単一 HTML を書き出す**(#400 段④)。
 *
 * ## 🔑 形は「雛形に差し込むだけ」
 *
 * アプリを畳むのは **build のとき 1 回**(`build/portable/fold.mjs`)。書き出しは
 * その**雛形を取ってきて、中身を差し込む**だけである。
 * ⚠ ブラウザの中で畳み直すと、**同じ規則が 2 か所**になる(CLAUDE.md §7)──
 * worker の classic 化も wasm の `data:` 化も、片方だけ上流に追随しなくなる。
 *
 * ## 🔴 雛形の中を「字面」で探してはいけない
 *
 * 雛形の 6.5 MB のほとんどは**アプリ本体の JS** で、そこには
 * **この file 自身の文字列**も入っている ── つまり `data-pkc-bundle` という
 * 綴りは、雛形の中に**必ず 2 回以上**現れる。
 * ⚠ `fold.mjs` はこの罠で 1 度アプリを真っ白にした(`</head>` が JS の中の
 * 文字列に当たった)。
 *
 * 🔑 だから位置で決める:
 * - **印は `<head>` の直後**(`fold.mjs` が保証。`PORTABLE_HEAD_SCAN` バイト以内)
 * - **差し込み先は最後の `</body>`**(アプリの JS はその前に在るので、
 *   `lastIndexOf` は必ず器のほうに当たる)
 *
 * ⚠ どちらも**当たらなければ落とす** ── 黙って差し込まないと、
 * 「書き出せたのに中身が入っていない HTML」が配られる。
 */
import { base64Chunks } from './pkc3-html';
import type { PortableBundle } from '../portable/bundle';

/**
 * 印を探す範囲。⚠ **これを広げてはいけない** ── 広げると、畳んだ JS の中の
 * 同じ綴りに当たる(この file の文字列がまさにそれである)。
 */
export const PORTABLE_HEAD_SCAN = 4096;

const TAG_RE = /<script type="application\/json" data-pkc-bundle>[^<]*<\/script>/g;

/** 添付の key に許す字。⚠ 属性へ入れるので、**入れる前に狭める**。 */
const ASSET_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function bundleTagHtml(bundle: PortableBundle): string {
  return (
    `<script type="application/json" data-pkc-bundle>` +
    JSON.stringify({ id: bundle.id, exportedAt: bundle.exportedAt }) +
    `</script>`
  );
}

/**
 * 雛形の頭に在る印を、この書き出しの印へ差し替える。
 * @throws 印が頭に 1 件で無ければ落とす(黙って差し替えないため)
 */
export function stampHead(head: string, bundle: PortableBundle): string {
  const hits = [...head.matchAll(TAG_RE)];
  if (hits.length !== 1)
    throw new Error(
      `雛形の印が頭に ${hits.length} 件でした(1 件でなければ差し替えられません)`,
    );
  return head.replace(TAG_RE, bundleTagHtml(bundle));
}

export interface PortableBundleResult {
  readonly blob: Blob;
  readonly warnings: string[];
  /** 焼いた添付の数(⚠ **0 件は「測っていない次元」**なので呼び側が見る)。 */
  readonly assets: number;
  readonly imageBytes: number;
}

/**
 * 雛形 + DB 画像 + 添付 → 1 個の HTML。
 *
 * ⚠ **bytes を配列に貯めない** ── base64 は 1 チャンクごとに `Blob` にして
 * 文字列を手放す(`pkc3-html.ts` 冒頭の実測: 16MB の添付で 21.34MB 常駐 → 0.00MB)。
 */
export async function writePortableBundle(args: {
  template: string;
  bundle: PortableBundle;
  image: Uint8Array;
  assets: AsyncIterable<{ key: string; mime: string; blob: Blob }>;
}): Promise<PortableBundleResult> {
  const { template, bundle, image } = args;
  if (image.byteLength === 0)
    throw new Error('DB の中身が空です(書き出すものがありません)');

  /**
   * 印を探すのは頭だけ、差し込み先を探すのは**全体の最後**。
   * ⚠ 2 つを「頭 / 残り」で分けて別々に探すと、**雛形が短いときに残りが空**になり
   *   差し込み先を見失う(1 稿目で踏んだ ── test の小さな雛形で落ちた)。
   * 🔑 印を差し替えてから 1 本に戻して、そこで探す。
   */
  const headLen = Math.min(PORTABLE_HEAD_SCAN, template.length);
  const stamped = stampHead(template.slice(0, headLen), bundle) + template.slice(headLen);
  /**
   * ⚠ **`lastIndexOf`** である ── アプリの JS は器の `</body>` より前に在るので、
   * 最後の 1 件は必ず器のほうに当たる。
   */
  const cut = stamped.lastIndexOf('</body>');
  if (cut < 0) throw new Error('雛形に `</body>` がありません(差し込み先が無い)');

  const parts: BlobPart[] = [stamped.slice(0, cut)];
  const warnings: string[] = [];

  parts.push('<script type="application/octet-stream;base64" data-pkc-db-image>');
  for await (const chunk of base64Chunks(new Blob([image as unknown as BlobPart])))
    parts.push(new Blob([chunk]));
  parts.push('</script>');

  let assets = 0;
  for await (const a of args.assets) {
    if (!ASSET_KEY_RE.test(a.key)) {
      // ⚠ 落とさず**名指しで注意**する ── 1 件の変な key で書き出し全体を
      //   失わせない(残りは正しく焼ける)
      warnings.push(`添付の key が扱えない形でした(焼いていません): ${a.key}`);
      continue;
    }
    parts.push(
      `<script type="application/octet-stream;base64" data-pkc-asset="${a.key}" ` +
        `data-pkc-asset-mime="${a.mime.replace(/[^A-Za-z0-9/.+-]/g, '')}">`,
    );
    for await (const chunk of base64Chunks(a.blob)) parts.push(new Blob([chunk]));
    parts.push('</script>');
    assets++;
  }

  parts.push(stamped.slice(cut));
  return {
    blob: new Blob(parts, { type: 'text/html;charset=utf-8' }),
    warnings,
    assets,
    imageBytes: image.byteLength,
  };
}
