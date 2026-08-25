/**
 * 🔴 **可搬単一 HTML を書き出す**(#400 段④)── 実行部。
 *
 * > 正本 doc §9.2 はこれを書き出し 3 形式のうち**「主」**と呼んでいる。
 *
 * ## ⚠ 「閲覧用 HTML」とは別物である
 *
 * | | 閲覧用 HTML(`export-html`) | **可搬単一 HTML**(ここ) |
 * |---|---|---|
 * | 中身 | 読むだけの器 + 本文 | **アプリそのもの** + DB 画像 + 添付 |
 * | できること | 読む | **読む・書く・続きを編集する** |
 * | 戻せるか | ❌ | ✅(その 1 枚が PKC3 である) |
 *
 * ## 🔑 形は「雛形に差し込むだけ」
 *
 * アプリを畳むのは build のとき 1 回(`build/portable/fold.mjs`)。ここは
 * その雛形を取ってきて中身を差し込む ── ⚠ ブラウザの中で畳み直すと
 * **同じ規則が 2 か所**になる(CLAUDE.md §7)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { safeName } from '@features/export/file-name';
import { writePortableBundle } from '@features/export/portable-bundle';
import type { PortableBundle } from '@features/portable/bundle';

export interface PortableExportDeps {
  /** 器の題名(ファイル名になる)。 */
  title: string;
  /**
   * 雛形(畳んだ 1 個の HTML)を取ってくる。
   * ⚠ **同じ origin から取る** ── `file://` では取れないので、呼び側が先に断る。
   */
  fetchTemplate(): Promise<string>;
  exportImage(): Promise<Uint8Array>;
  listAssets(): Promise<ReadonlyArray<{ key: string; mime: string }>>;
  getAsset(key: string): Promise<Blob | null>;
  download(name: string, blob: Blob): void;
  notify(message: string): void;
  report(notes: readonly string[]): void;
  /** 🔴 飛んでいる書込を着地させてから読む(読みは書込の chain の外に居る)。 */
  settle(): Promise<void>;
  /**
   * 🔴 **いま可搬バンドルの中で走っているか**。
   * ⚠ そのときは断る ── 雛形は同じ origin から取るしかなく、`file://` では
   *   取りに行けない。**黙って失敗させない**(「押しても何も起きない」を作らない)。
   */
  insideBundle(): boolean;
  now?(): Date;
  mintId?(): string;
}

/** ⚠ `isBundleId` を満たす形にする(`[a-z0-9]` で始まる 8〜64 字)。 */
function defaultMintId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `pkcb-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * 書き出して download させる。
 * @returns 焼いた添付の数(失敗時は `null`)
 */
export async function exportPortable(
  dispatcher: Dispatcher,
  deps: PortableExportDeps,
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  if (dispatcher.getState().phase !== 'ready')
    return fail('編集を終了してから書き出してください');

  /**
   * ⚠ **押せてしまうより、押した理由に答える。** ここを黙って失敗させると
   *   「押しても何も起きない」になる(#180 の dead click と同じ形)。
   */
  if (deps.insideBundle())
    return fail(
      'この 1 枚から可搬 HTML は作れません ── いま開いているのは配られた 1 枚で、' +
        'アプリの雛形を取りに行けないためです。ブラウザで開いた PKC3 から書き出してください',
    );

  deps.notify('可搬 HTML を書き出しています…');
  try {
    // 🔴 直前の保存が disk に着いてから読む
    await deps.settle();
    const image = await deps.exportImage();
    if (image.byteLength === 0) return fail('中身がまだ空です(書き出すものがありません)');

    const template = await deps.fetchTemplate();
    const metas = await deps.listAssets();
    const bundle: PortableBundle = {
      id: (deps.mintId ?? defaultMintId)(),
      exportedAt: (deps.now?.() ?? new Date()).getTime(),
    };

    const missing: string[] = [];
    /**
     * ⚠ **bytes を配列に貯めない** ── 1 件ずつ渡して、writer が
     *   その場で base64 → `Blob` にする(`pkc3-html.ts` の実測: 16MB の添付で
     *   21.34MB 常駐 → 0.00MB)。
     */
    async function* assets(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {
      for (const m of metas) {
        const blob = await deps.getAsset(m.key);
        if (blob === null) {
          // 🔴 **黙って落とさない** ── 欠けたことを user に言う
          missing.push(`添付の中身が見つかりませんでした: ${m.key}`);
          continue;
        }
        yield { key: m.key, mime: m.mime, blob };
      }
    }

    const out = await writePortableBundle({ template, bundle, image, assets: assets() });
    const now = deps.now?.() ?? new Date();
    deps.download(`${safeName(deps.title)}-${stamp(now)}.pkc3.html`, out.blob);

    const notes = [...missing, ...out.warnings];
    if (notes.length > 0) deps.report(notes);
    deps.notify(
      `可搬 HTML を書き出しました(添付 ${out.assets} 件` +
        (notes.length > 0 ? ` / ⚠ 注意 ${notes.length} 件` : '') +
        ')',
    );
    return out.assets;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
