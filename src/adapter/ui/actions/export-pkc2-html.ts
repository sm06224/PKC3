/**
 * 🔴 **PKC2 のポータブル形式(ノートも編集できる単一 HTML)で書き出す**(台帳 #1416。user 指示 2026-10-07)── 実行部。
 *
 * ## 何をするか
 *
 * PKC2 の「持ち運べる HTML」は、**PKC2 のアプリ本体 + データ(`#pkc-data`)**の 1 枚である。PKC3 の中に PKC2 のアプリは無い
 * (PKC2 は参照のみ ── 丸ごとは持ち込まない)ので、**user が手元の PKC2 の HTML(配布の `pkc2.html` や、PKC2 が書き出した
 * HTML)を 1 つ選ぶ**。その `#pkc-data` だけを PKC3 のノートで入れ替えて、`pkc2-<題名>-<日付>.html` として渡す。
 * - 元にした PKC2 の HTML は変えない(読むだけ)。入れ替わるのは書き出すファイルの中のデータだけ。
 * - 変換の規則は `features/export/pkc2-container.ts`(何が落ちるかもそこ)。落ちる物は件数で言う。
 * - 添付は 1 件ずつ base64 にして Blob の部品へ(巨大な文字列を溜めない)。
 *
 * ⚠ 書き出しの共通の作法に乗る: 編集中は断る・直前の保存を待つ・「やめる」(`job-control.ts`)・失敗は可視。
 */
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { exportBlockedNote } from '@adapter/state/app-state';
import { safeName } from '@features/export/file-name';
import { isOperationCancelled } from '@features/job-cancel';
import {
  pkc2DataParts,
  pkc2HtmlFileName,
  planPkc2Container,
  Pkc2ShellError,
  shellSchemaVersion,
  splitPkc2Shell,
} from '@features/export/pkc2-container';
import type { ExportDeps } from './export-archive';

/** 進行中の字(`…` で終わる ── 結果が出たら置き換わる)。 */
export const PKC2_HTML_STARTING = 'PKC2 の HTML を書き出しています…';

/** Blob → base64(`data:` の頭を落とす)。1 件ぶんだけ文字列になる。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('添付を読めませんでした'));
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.readAsDataURL(blob);
  });
}

/**
 * 書き出して download させる。
 * @param shellHtml user が選んだ PKC2 の HTML の中身(文字)
 * @returns 書き出したノートの数(失敗・やめた回は `null`)
 */
export async function exportPkc2Html(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  shellHtml: string,
): Promise<number | null> {
  let progressShown = false;
  const fail = (msg: string): null => {
    if (progressShown) deps.notify?.('');
    progressShown = false;
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) return fail(blocked);

  // 先に元の HTML を確かめる(読みに行く前に断る ── 30MB を読んでから「PKC2 の HTML ではない」と言わない)
  let shell: { before: string; after: string };
  try {
    shell = splitPkc2Shell(shellHtml);
  } catch (e) {
    return fail(e instanceof Pkc2ShellError ? e.message : `書き出しに失敗しました: ${errorText(e)}`);
  }

  deps.notify?.(PKC2_HTML_STARTING);
  progressShown = true;
  const token = deps.job?.start('export') ?? null;
  try {
    await deps.settle();
    token?.throwIfCancelled();
    const src = deps.source;
    const now = deps.now?.() ?? new Date();

    const metas = await src.listEntryMetas();
    token?.throwIfCancelled();
    // 本文は 1 かたまりずつ(`listBodies` のページング ── 全部を一度に読まない)
    const bodies = new Map<string, string>();
    let after: { entryOrder: number; lid: string } | undefined;
    for (;;) {
      token?.throwIfCancelled();
      const page = await src.listBodies(after, 8 * 1024 * 1024);
      for (const r of page.rows) bodies.set(r.lid, r.body);
      if (page.done || page.next === undefined) break;
      after = page.next;
    }
    const relations = await src.listRelations();
    const assetMetas = await src.listAssetMetas();
    token?.throwIfCancelled();

    const plan = planPkc2Container({
      title: src.title,
      containerId: src.cid,
      entries: metas.map((m) => ({
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        body: bodies.get(m.lid) ?? '',
        entryOrder: m.entry_order,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      })),
      relations: relations.map((r) => ({
        id: r.id,
        fromLid: r.from_lid,
        toLid: r.to_lid,
        kind: r.kind,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      assets: new Map(assetMetas.map((a) => [a.key, { mime: a.mime ?? 'application/octet-stream', size: a.size }])),
      now,
      schemaVersion: shellSchemaVersion(shell.before),
    });

    // 本文で使われている添付だけでなく、持っている添付を全部(PKC2 の添付のノートも bytes が要る)
    let missing = 0;
    async function* assets(): AsyncGenerator<{ key: string; base64: string }> {
      for (const m of assetMetas) {
        token?.throwIfCancelled(); // 添付 1 件ごとが区切り
        const blob = await src.getAssetBlob(m.key);
        if (blob === null) {
          missing += 1; // 黙って落とさない(下で言う)
          continue;
        }
        yield { key: plan.assetKeys.get(m.key) ?? m.key, base64: await blobToBase64(blob) };
      }
    }
    const dataParts = await pkc2DataParts(plan.container, assets());

    token?.throwIfCancelled();
    const blob = new Blob([shell.before, ...dataParts, shell.after], { type: 'text/html' });
    token?.throwIfCancelled(); // 組み終えた後にやめられても、ダウンロードは始めない
    deps.download(pkc2HtmlFileName(safeName(src.title), now), blob);

    const notes = [...plan.warnings, ...(missing > 0 ? [`添付 ${missing} 件の中身が見つからず、入れられませんでした`] : [])];
    deps.report(notes);
    progressShown = false; // 次の知らせが進行中の欄を空にする
    deps.notify?.(
      `PKC2 の HTML を書き出しました(ノート ${plan.container.entries.length} 件・添付 ${assetMetas.length - missing} 件` +
        (notes.length > 0 ? ` / 注意 ${notes.length} 件` : '') +
        ')',
    );
    return plan.container.entries.length;
  } catch (e) {
    if (isOperationCancelled(e)) {
      progressShown = false;
      deps.notify?.('書き出しをやめました(ファイルは作っていません)');
      return null;
    }
    return fail(`書き出しに失敗しました: ${errorText(e)}`);
  } finally {
    if (token !== null) deps.job?.finish(token);
  }
}
