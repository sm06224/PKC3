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
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { exportBlockedNote } from '@adapter/state/app-state';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';
import { writePortableBundle } from '@features/export/portable-bundle';
import type { PortableBundle } from '@features/portable/bundle';
import { EmptyClosureError, type PortableClosure } from '@features/export/portable-closure';

/**
 * 🔴 **PKC3 入り HTML の中からは書き出せない理由**(台帳 #1852 束 L2。依頼 84-4 B)。
 * ⚠ ボタンを押したときの断りと、押せない見た目の隣に**いつも出す理由**(右の列)が、同じ字を引く(2 か所に書かない)。
 */
export const INSIDE_BUNDLE_REFUSAL =
  'いま開いているのは PKC3 入り HTML で、元になるファイルを取得できないため、' +
  'ここからは PKC3 入り HTML を作れません。ブラウザで開いた PKC3 から書き出してください';

export interface PortableExportDeps {
  /** 器の題名(ファイル名になる)。 */
  title: string;
  /**
   * 雛形(畳んだ 1 個の HTML)を取ってくる。
   * ⚠ **同じ origin から取る** ── `file://` では取れないので、呼び側が先に断る。
   */
  fetchTemplate(): Promise<string>;
  /** `only` を渡すと、その lid のノートと添付だけの画像にする(#1038 A2。本体の DB は変えない)。 */
  exportImage(only?: { lids: string[]; assetKeys: string[] }): Promise<Uint8Array>;
  /** 🔴 選んだ N 件の閉包(参照先・添付・祖先フォルダ)を決める。`selection` を渡す呼び出しだけが使う。 */
  closure?(selection: readonly string[]): Promise<PortableClosure>;
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

/**
 * 🔴 **雛形(畳んだ 1 個の HTML)を取る**。失敗の字はここで決める(main.ts に判断を置かない)。
 *
 * - 404 = この PKC3 に雛形が同梱されていない配り方 ── user が次にすること(公開版を開く)を言う
 * - 通信が無い(`Failed to fetch`)は例外のまま投げる ── 画面に出る手前の `errorText` が日本語にする
 *
 * @param fetchFn `fetch` 相当(test から差し替える)
 */
export async function fetchPortableTemplate(
  fetchFn: (url: URL) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
  baseURI: string,
): Promise<string> {
  const res = await fetchFn(new URL('portable-template.html', baseURI));
  if (res.status === 404)
    throw new Error(
      'PKC3 入り HTML を作るのに必要なファイルが、この PKC3 には入っていません。' +
        'インターネット上の公開版を開いて、書き出してください',
    );
  if (!res.ok)
    throw new Error(`PKC3 入り HTML を作るのに必要なファイルを取得できませんでした(HTTP ${res.status})`);
  return res.text();
}

/** ⚠ `isBundleId` を満たす形にする(`[a-z0-9]` で始まる 8〜64 字)。 */
function defaultMintId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `pkcb-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// 🔑 file 名の「今日」は `dayStamp`(端末の暦日)1 本 ── ここに私的な stamp を持たない(#709)
const stamp = (d: Date): string => dayStamp(d, '');

/**
 * 書き出して download させる。
 * @returns 焼いた添付の数(失敗時は `null`)
 */
export async function exportPortable(
  dispatcher: Dispatcher,
  deps: PortableExportDeps,
  /** 🔑 渡すと「選んだ N 件」だけの PKC3 入り HTML にする(#1038 A2)。省略 = 全件。 */
  selection?: readonly string[],
): Promise<number | null> {
  // 🔴 進行中の字を失敗のときに消す(#1017 C5)── 出す前の断りは消さない(別の知らせを巻き込まない)
  let progressShown = false;
  const fail = (msg: string): null => {
    if (progressShown) deps.notify('');
    progressShown = false;
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) return fail(blocked);

  /**
   * ⚠ **押せてしまうより、押した理由に答える。** ここを黙って失敗させると
   *   「押しても何も起きない」になる(#180 の dead click と同じ形)。
   */
  if (deps.insideBundle()) return fail(INSIDE_BUNDLE_REFUSAL);

  deps.notify('PKC3 入り HTML を書き出しています…');
  progressShown = true;
  try {
    // 🔴 直前の保存が disk に着いてから読む
    await deps.settle();
    let closure: PortableClosure | null = null;
    if (selection !== undefined) {
      if (deps.closure === undefined) return fail('書き出しに失敗しました: 選んだノートの範囲を決められません');
      try {
        closure = await deps.closure(selection);
      } catch (e) {
        if (e instanceof EmptyClosureError) return fail('書き出すノートが見つかりません');
        throw e;
      }
    }
    const image = await deps.exportImage(
      closure === null ? undefined : { lids: closure.lids, assetKeys: closure.assetKeys },
    );
    if (image.byteLength === 0) return fail('中身がまだ空です(書き出すものがありません)');

    const template = await deps.fetchTemplate();
    const allMetas = await deps.listAssets();
    // 🔑 選んだ分のときは、閉包の添付だけを焼く(画像の目録と焼く bytes を揃える)
    const keep = closure === null ? null : new Set(closure.assetKeys);
    const metas = keep === null ? allMetas : allMetas.filter((m) => keep.has(m.key));
    const bundle: PortableBundle = {
      id: (deps.mintId ?? defaultMintId)(),
      exportedAt: (deps.now?.() ?? new Date()).getTime(),
    };

    // 🔑 件数だけ数える ── 内部の id は画面の字にしない(user が読んで何もできない)
    let missingCount = 0;
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
          missingCount += 1;
          continue;
        }
        yield { key: m.key, mime: m.mime, blob };
      }
    }

    const out = await writePortableBundle({ template, bundle, image, assets: assets() });
    const now = deps.now?.() ?? new Date();
    deps.download(`${safeName(closure?.title ?? deps.title)}-${stamp(now)}.pkc3.html`, out.blob);

    const missing =
      missingCount > 0
        ? [`添付 ${missingCount} 件の中身が見つからず、PKC3 入り HTML には入れられませんでした`]
        : [];
    const notes = [...(closure?.warnings ?? []), ...missing, ...out.warnings];
    if (notes.length > 0) deps.report(notes);
    progressShown = false; // ⚠ 次の「書き出しました」が進行中の欄を空にする(`status-lifetime.ts` ── 結果は進行中の終わりでもある)
    deps.notify(
      `PKC3 入り HTML を書き出しました(` +
        // 🔑 選んだ分のときは、入れた範囲を言う(選んでいない参照先・祖先フォルダが混ざるため)
        (closure === null
          ? ''
          : `選んだ ${closure.selected} 件 + 参照先 ${closure.referenced} 件 + 祖先フォルダ ${closure.ancestors} 件 / `) +
        `添付 ${out.assets} 件` +
        (notes.length > 0 ? ` / 注意 ${notes.length} 件` : '') +
        ')',
    );
    return out.assets;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${errorText(e)}`);
  }
}
