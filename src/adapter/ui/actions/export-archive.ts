/**
 * P6d 段②: アーカイブ ZIP の書出し(実行部)。
 *
 * 🔴 **writer だけ増やしても user は 1 件も書き出せない**(P6b で確立した規律 ──
 * 受理器だけ増やして「読めたつもり」の検証もできなかった失敗の裏返し)。
 * ここで store → 書出し → ダウンロードまでを 1 本に通す。
 *
 * ⚠ 書出しは **asset gate の内側**(取込 / 整理と排他)。書出し中に添付が
 * 掃除されると「meta はあるが bytes が無い」を掴んで欠けたアーカイブができる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { writeArchive, type ArchiveSource } from '@features/export/pkc3-archive';
import type { RenderMarkdownOptions } from '@features/markdown/markdown-render';
import { writePortableHtml } from '@features/export/pkc3-html';
import { buildDocx } from '@features/export/docx';
import { ZipWriter } from '@features/export/zip-writer';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { DEFAULT_PAGE_FORMAT, type PageFormat } from '@features/page-format';
import { writeMarkdownZip } from '@features/export/pkc3-markdown-zip';
import { singleEntrySource } from '@features/export/single-entry-source';
import { safeName } from '@features/export/file-name';

export interface ExportDeps {
  source: ArchiveSource;
  /** 生成した Blob を user に渡す(実配線は `<a download>`)。 */
  download(name: string, blob: Blob): void;
  notify?(message: string): void;
  /**
   * 注意の全件(1 行の status では 1 件目しか届かない ── P6c review H-2)。
   *
   * ⚠ **optional にしない**(review M1)。リファクタでこの配線が落ちたとき、
   * optional だと typecheck も lint も test も鳴らず、user が見るのは
   * 「⚠ 注意 1 件」だけ ── **どの添付が欠けたか**が消える。必須にしておけば
   * 配線を落とした瞬間に tsc が止める。要らない呼び出し側は `() => {}` を書く
   * (書かされること自体が「注意を捨てている」の明示になる)
   */
  report(notes: readonly string[]): void;
  /**
   * 🔴 **飛んでいる書込を着地させてから読む**(2026-08-17 に実測で判明)。
   *
   * 書込は effect 層の 1 本の chain に直列化されるが、**書き出しの読みはその外**に
   * ある ── `getBody` は並んでいる書込を**追い越す**。実測(実ブラウザ、保存の
   * 直後に Word を押す)では **11/12 が保存前の本文**を書き出した。
   * 実体は `connectStoreEffects` が返す `settled()`。
   *
   * ⚠ **optional にしない**(`report` と同じ理由 ── review M1)。配線が落ちても
   * typecheck が黙ると、user から見える症状は「保存したのに古い本文が出る」
   * という**いちばん気づけない形**で戻ってくる。待つものが無い呼び側は
   * `async () => {}` を書く(書かされること自体が「待たない」の明示になる)。
   */
  settle(): Promise<void>;
  now?(): Date;
  /**
   * 本文 1 件を HTML にする(閲覧用 HTML だけが使う。P8 段⑲)。
   *
   * ⚠ **省略できるようにしてある**が、アプリからは必ず**markdown ワーカー**を
   * 渡す ── 省略するとその場で描くので、件数ぶんメインスレッドが止まる
   * (user 指示 2026-08-03「基本的に重い処理はワーカーにしてください」)。
   */
  renderBody?(text: string, opts?: RenderMarkdownOptions): Promise<string>;
  /**
   * 書き出す HTML に外部画像を焼くか(2026-08-06、user 裁定)。
   * ⚠ **設定が「常にオン」のときだけ true** ── 判断は `main.ts` が持つ。
   *   ノートごとの同意は持ち込まない(書き出した HTML は別の人が開く)。
   */
  allowExternalImages?: boolean;
  /**
   * 紙面フォーマット(2026-08-08、user 裁定)。**書き出した瞬間の設定**を焼く。
   * ⚠ 省略すると既定(A4 縦)── いままでと同じ見え方に倒れる。
   * ⚠ 判断は `main.ts` が持つ(いま画面に当たっている値をそのまま渡す)。
   */
  pageFormat?: PageFormat;
}


const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** 書き出す形式。⚠ **可逆なのはアーカイブだけ**(UI でそう言う)。 */
export type ExportKind = 'archive' | 'html' | 'markdown';

/**
 * このノートだけをアーカイブとして書き出す(P6f)。
 *
 * user 指示 2026-08-02:「そういうのは削除じゃなくて**アーカイブエクスポートの
 * 導線**を用意すればいいのでは?」── 消す前に手元へ出せる場所を作る。
 * 形式はバックアップと**同じ** `.pkc3.zip` なので、そのまま取り込み直せる。
 */
export async function exportEntry(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<number | null> {
  // ⚠ **読みの前**に断る(review M-2)。`singleEntrySource` は store を舐めるので、
  // ガードが後ろにあると「30MB 読んでから編集中ですと言う」になる。
  // さらに、読みの途中で編集が確定すると body と鎖の基準 tip が別時刻になり、
  // 「読み → 編集 → 保存(ready へ戻る)→ ガード通過」で内部矛盾したアーカイブができる
  if (dispatcher.getState().phase !== 'ready') {
    dispatcher.dispatch({ type: 'OP_FAILED', error: '編集を終了してから書き出してください' });
    return null;
  }
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const { source, warnings } = await singleEntrySource(deps.source, lid);
    const n = await exportArchive(dispatcher, { ...deps, source }, 'archive', warnings);
    return n;
  } catch (e) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    });
    return null;
  }
}

/**
 * 書き出してダウンロードさせる。
 * @returns 書き出した entry 数(失敗時は null)
 */
export async function exportArchive(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  kind: ExportKind = 'archive',
  /** 呼び出し側が先に見つけた注意(1 ノート書出しの「関連は落ちる」等)。 */
  extraWarnings: readonly string[] = [],
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから書き出してください');
  }

  const STARTING: Record<ExportKind, string> = {
    archive: '書き出しています…',
    html: '閲覧用 HTML を書き出しています…',
    markdown: 'Markdown を書き出しています…',
  };
  deps.notify?.(STARTING[kind]);
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const now = deps.now?.() ?? new Date();
    const base = `${safeName(deps.source.title)}-${stamp(now)}`;
    const iso = now.toISOString();

    let out: {
      blob: Blob;
      warnings: string[];
      counts: { entries: number; assets: number; relations?: number; revisions?: number };
    };
    let name: string;
    let detail: string;
    if (kind === 'html') {
      out = await writePortableHtml(
        deps.source,
        iso,
        deps.renderBody,
        deps.allowExternalImages === true,
        deps.pageFormat ?? DEFAULT_PAGE_FORMAT,
      );
      name = `${base}.html`;
      // ⚠ **可逆ではない**ことをその場で言う(後から見分けられない形にしない ──
      // PKC2 は light / full の別を manifest にしか書いておらず user が困っていた)
      detail = `${out.counts.entries} 件(添付 ${out.counts.assets})── 閲覧用(取り込み直せません)`;
    } else if (kind === 'markdown') {
      const md = await writeMarkdownZip(deps.source, iso);
      out = md;
      name = `${base}.md.zip`;
      // 🔴 **何が落ちたかを件数で言う**(設計 doc §3-2)。PKC2 は落ちたことを
      // 言わずに出していた ── 「片道です」だけでは user は損失量を測れない
      const lost: string[] = [];
      if (md.dropped.relations > 0) lost.push(`関連 ${md.dropped.relations}`);
      if (md.dropped.revisionEntries > 0) lost.push(`履歴 ${md.dropped.revisionEntries} 件ぶん`);
      // 🔴 **控え(過去の版)の件数を出す**(#213 / user 裁定 A 2026-08-16)。
      //    ⚠ 出さないと「添付 200 件」とだけ出て、**なぜ zip が大きいのか**が
      //    どこにも書かれていない。⚠ 減らすのではなく**言う**のが裁定 A である
      const assetsText =
        md.counts.historyAssets > 0
          ? `添付 ${md.counts.assets}(うち控え ${md.counts.historyAssets})`
          : `添付 ${md.counts.assets}`;
      detail =
        `${md.counts.entries} 件(${assetsText})── 片道` +
        (lost.length > 0 ? `(${lost.join(' / ')}が落ちます)` : '(取り込み直せません)');
    } else {
      out = await writeArchive(deps.source, iso);
      name = `${base}.pkc3.zip`;
      const c = out.counts;
      detail = `${c.entries} 件(関連 ${c.relations} / 履歴 ${c.revisions} / 添付 ${c.assets})`;
    }
    deps.download(name, out.blob);
    const notes = [...extraWarnings, ...out.warnings];
    deps.report(notes);
    deps.notify?.(
      notes.length > 0
        ? `書き出しました: ${detail} ⚠ 注意 ${notes.length} 件`
        : `書き出しました: ${detail}`,
    );
    return out.counts.entries;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 🔴 **このノートを Word(.docx)で書き出す**(#187 段①)。
 *
 * 🔑 **画面と同じ HTML から組む**(設計 doc の (b))── `renderBody` は閲覧用 HTML と
 * **同じ口**である。PKC2 はここを別のレンダラにしたせいで「Word で直した」が
 * PDF に届かず、記録されている不具合がほぼ全部その土台に乗っていた。
 *
 * ⚠ **1 ノート = 1 文書**にする。Word の文書は「1 本の文書」なので、
 * 何百件を 1 つに連ねる形は user の期待と違う(バックアップは `.pkc3.zip` が持つ)。
 * ⚠ 段① は**画像を入れない** ── 入れない代わりに、その場に理由を書いて件数で言う。
 */
export async function exportEntryDocx(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<boolean> {
  const fail = (msg: string): boolean => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return false;
  };
  // ⚠ 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  if (dispatcher.getState().phase !== 'ready')
    return fail('編集を終了してから書き出してください');
  if (!deps.renderBody)
    return fail('本文を組み立てられませんでした(描画の口が渡っていません)');
  deps.notify?.('Word で書き出しています…');
  try {
    /**
     * 🔴 **直前の保存が disk に着いてから読む**(2026-08-17 実測)。
     * ⚠ `phase === 'ready'` は「編集を終えた」しか言っていない ── 本文の書込は
     * その後ろで飛んでいて、ここの `getBody` は**それを追い越す**。
     */
    await deps.settle();
    // ⚠ 1 件だけの読み口(P6f)。⚠ 省略可なので**在ることを確かめてから**呼ぶ
    if (!deps.source.getBody) return fail('本文の読み口が渡っていません');
    const body = await deps.source.getBody(lid);
    if (body === null) return fail('ノートが見つかりませんでした');
    const metas = await deps.source.listEntryMetas();
    const title = metas.find((m) => m.lid === lid)?.title ?? 'ノート';
    const html = await deps.renderBody(body);
    // ⚠ `<body>` で包む ── 包まないと happy-dom / 実ブラウザで木の形が揃わない
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const { blocks, images } = htmlToDocxBlocks(doc);
    /**
     * 🔴 **添付の画像を入れる**(#187 段②)。
     * ⚠ **縦横比を保つ**ため、実寸を取ってから渡す(PKC2 は全画像を 480×360 px に
     *   潰していた)。⚠ 取れなかったものは `skipped` のまま残す ── **黙って
     *   落とさない**(本文にその場所と理由が出る)。
     * ⚠ bytes は **Blob のまま** zip へ渡す(heap に載せない ── 不可侵指示 2026-07-27)。
     */
    const media: { name: string; blob: Blob }[] = [];
    for (const [i, img] of images.entries()) {
      const blob = await deps.source.getAssetBlob(img.assetKey).catch(() => null);
      if (!blob) continue;
      const type = blob.type || 'image/png';
      // ⚠ Word が素で読める形だけ入れる(読めない形を入れると file ごと開けない)
      const ext = /jpe?g/.test(type)
        ? 'jpeg'
        : type.includes('gif')
          ? 'gif'
          : type.includes('webp')
            ? 'webp'
            : type.includes('png')
              ? 'png'
              : null;
      if (ext === null) {
        blocks[img.at] = {
          kind: 'skipped',
          what: `画像「${img.alt}」`,
          why: `この形式は Word に入れられません(${type})`,
        };
        continue;
      }
      const size = await imageSizeOf(blob);
      if (size === null) {
        blocks[img.at] = {
          kind: 'skipped',
          what: `画像「${img.alt}」`,
          why: '大きさを読めませんでした',
        };
        continue;
      }
      const name = `media/image${i + 1}.${ext}`;
      blocks[img.at] = {
        kind: 'image',
        media: name,
        widthPx: size.w,
        heightPx: size.h,
        alt: img.alt,
      };
      media.push({ name: `word/${name}`, blob });
    }
    const now = deps.now?.() ?? new Date();
    const built = buildDocx(blocks, title, now.toISOString());
    const zip = new ZipWriter();
    for (const part of built.parts) await zip.add(part.name, [part.text]);
    for (const m of media) await zip.add(m.name, [m.blob]);
    deps.download(`${safeName(title)}-${stamp(now)}.docx`, zip.finish());
    // 🔴 **落としたものは件数で言う**(#213 の裁定 A と同じ向き)
    deps.report(built.warnings);
    // ⚠ 「書き出しました」は `notify`(一時の知らせ)で言う ── state の action に
    //    書き出し用の型は無い(増やさない)
    deps.notify?.(
      `Word で書き出しました(${built.counts.blocks} 塊 / 画像 ${built.counts.images} 枚)`,
    );
    return true;
  } catch (e) {
    return fail(`Word の書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 画像の**実寸**(px)。⚠ 取れなければ `null` ── 呼び側は**入れずに理由を残す**。
 *
 * 🔑 `createImageBitmap` を使う(`<img>` を作らない)── DOM に足さずに読め、
 * **すぐ `close()` して返せる**(不可侵指示 2026-07-27「生成物のライフサイクル
 * 終端で速やかに破棄」)。
 */
async function imageSizeOf(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size.w > 0 && size.h > 0 ? size : null;
  } catch {
    return null;
  }
}
