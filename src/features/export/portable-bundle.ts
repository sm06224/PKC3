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
import {
  MAX_EMBED_TEXT_CHARS,
  base64Length,
  notImportableBackMessage,
  tooBigToReadBack,
  tooBigToReadBackMessage,
} from '../storage/image-export-limit';
import { IMAGE_PART_BYTES, imagePartMark, type PortableBundle } from '../portable/bundle';

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
 * テンプレートの頭に在る目印を、この書き出しの目印へ差し替える。
 * @throws 目印が頭に 1 件で無ければ落とす(黙って差し替えないため)
 */
export function stampHead(head: string, bundle: PortableBundle): string {
  const hits = [...head.matchAll(TAG_RE)];
  if (hits.length !== 1)
    throw new Error(
      `テンプレートの目印がヘッダーに ${hits.length} 件でした(1 件でなければ差し替えられません)`,
    );
  return head.replace(TAG_RE, bundleTagHtml(bundle));
}

export interface PortableBundleResult {
  readonly blob: Blob;
  readonly warnings: string[];
  /** 焼いた添付の数(⚠ **0 件は「測っていない次元」**なので呼び側が見る)。 */
  readonly assets: number;
  readonly imageBytes: number;
  /** 焼いたファイル全体のおよその字数(取り込み直しの上限の見積もり)。⚠ 実際より多め(枠の見積もり)。 */
  readonly estimatedChars: number;
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
   * 🔴 **焼けるが開けない大きさを、焼かせない**(#996)。
   *
   * ⚠ 下の `base64Chunks` は文字列を**刻んで `Blob` にする**ので、
   *   どんなに大きくても**書けてしまう** ── そして読み戻す側は
   *   `<script>` の `textContent` = **1 本の文字列**なので、
   *   上限(実測 536,870,880 字 < 上限 <= 536,870,912 字)を超えると
   *   🔴 **ファイルはできるのに二度と開けない**。
   * 🔑 だから**ここで断る** ── 断らないと、user は
   *   「バックアップを取った」と思ったまま**必要になった日に失う**。
   */
  if (tooBigToReadBack(image.byteLength))
    throw new Error(tooBigToReadBackMessage('いまの中身', image.byteLength));

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
  if (cut < 0) throw new Error('テンプレートに `</body>` がありません(差し込み先が無い)');

  const parts: BlobPart[] = [stamped.slice(0, cut)];
  const warnings: string[] = [];

  /**
   * 🔴 **DB 画像は `IMAGE_PART_BYTES` ごとの `<script>` に割る**(#1416 §7-4)。1 本に入れると、
   * 開くとき HTML の読み手が二乗で遅くなる(150MB の DB で 27 秒。割ると読み込みは大きさに比例)。
   * 印は `data-pkc-db-image="<番号>/<総数>"` ── 読み戻す側が欠けと順の乱れを見分ける。
   */
  const partCount = Math.ceil(image.byteLength / IMAGE_PART_BYTES);
  for (let p = 0; p < partCount; p++) {
    parts.push(
      `<script type="application/octet-stream;base64" data-pkc-db-image="${imagePartMark(p, partCount)}">`,
    );
    const slice = image.subarray(p * IMAGE_PART_BYTES, (p + 1) * IMAGE_PART_BYTES);
    for await (const chunk of base64Chunks(new Blob([slice as unknown as BlobPart])))
      parts.push(new Blob([chunk]));
    parts.push('</script>');
  }

  /**
   * これまでに焼いた字数(雛形の全部 + DB 画像の base64 と要素の枠。枠は多めに 120 字と見積もる)。添付の天井の見積もりに使う。
   * ⚠ 取り込み側が読む「HTML ファイル全体の字数」に合わせる(雛形の尾も含む)。
   */
  let fileChars = stamped.length + base64Length(image.byteLength) + partCount * 120;
  let assets = 0;
  for await (const a of args.assets) {
    if (!ASSET_KEY_RE.test(a.key)) {
      // ⚠ 落とさず**名指しで注意**する ── 1 件の変な key で書き出し全体を
      //   失わせない(残りは正しく焼ける)
      warnings.push(`添付の ID が扱えない形でした(埋め込んでいません): ${a.key}`);
      continue;
    }
    /**
     * 🔴 **添付も `IMAGE_PART_BYTES` ごとの `<script>` に割る**(#1416 §7-4d)。1 件が大きいと、DB 画像と同じく
     * HTML の読み込みが二乗で遅くなる(アプリ抜きの対照で 120MB の 1 本が 7.6 秒 → 割ると 2.0 秒)。
     * 割った要素は `data-pkc-asset-part="<番号>/<総数>"` を持つ。**1 要素で済む大きさは、割る前の版と同じ形**
     * (印を付けない ── 古い取り込み口でも読める)。
     */
    const nParts = Math.max(1, Math.ceil(a.blob.size / IMAGE_PART_BYTES));
    const openTag = (p: number): string =>
      `<script type="application/octet-stream;base64" data-pkc-asset="${a.key}" ` +
      `data-pkc-asset-mime="${a.mime.replace(/[^A-Za-z0-9/.+-]/g, '')}"` +
      (nParts === 1 ? '>' : ` data-pkc-asset-part="${imagePartMark(p, nParts)}">`);
    /**
     * 🔴 **残る天井は「ファイル全体」** ── 開く側は要素ごとに読む(割ってあるので 1 件の大きさでは詰まらない)が、
     * **取り込み直す側は HTML ファイル全体を 1 本の文字列にする**(`File.text()`)ので、上限は
     * 雛形 + DB 画像 + 添付の全部を足した字数に効く。⚠ 添付 1 件の大きさではなく**これまでに焼いた分との合計**で見る。
     * 🔑 **落とさない** ── 開くことが本命で、割ってあれば大きさに関わらず開ける。超えたら
     *   **全部焼いたうえで、最後に 1 度だけ**「開けるが取り込み直せないことがある」と言う(下)。
     */
    const addChars = base64Length(a.blob.size) + nParts * (openTag(0).length + '</script>'.length);
    fileChars += addChars;
    for (let p = 0; p < nParts; p++) {
      parts.push(openTag(p));
      const slice = a.blob.slice(p * IMAGE_PART_BYTES, (p + 1) * IMAGE_PART_BYTES);
      for await (const chunk of base64Chunks(slice)) parts.push(new Blob([chunk]));
      parts.push('</script>');
    }
    assets++;
  }

  // 🔴 取り込み直せない大きさになったら、**1 度だけ**言う(添付は 1 件も落としていない)
  if (fileChars > MAX_EMBED_TEXT_CHARS) warnings.push(notImportableBackMessage(fileChars));

  parts.push(stamped.slice(cut));
  return {
    blob: new Blob(parts, { type: 'text/html;charset=utf-8' }),
    warnings,
    assets,
    imageBytes: image.byteLength,
    estimatedChars: fileChars,
  };
}
