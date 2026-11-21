/**
 * 🔴 **旧版 PKC のテンプレート zip の取込**(#2002 段 3)── `template.yaml` + `forms/*.yaml` を、ふつうのフォルダ・ノートにする。
 *
 * 入口は `import-pkc2.ts` の「manifest の無い zip」の分岐(`isTemplateZip` が真のときだけ来る。他の zip の道は変えない)。
 * 読む規則は `features/import/template-zip.ts`(pure)。⚠ **読み終えてから 1 度だけ書く**(途中で誤りが出たら 1 件も作らない)。
 * 取り込めなかった物は**出どころつきで全部**結果に出す(`report`)。
 */
import { humanBytes } from '@features/human-bytes';
import { errorText } from '@features/error-text';
import { markName } from '@features/message/message-log';
import { readZipDirectory, readZipText, unwrapSingleTopDir, ZipReadError } from '@features/import/zip-reader';
import {
  convertTemplate,
  oneLine,
  findTemplateRoot,
  TemplateImportError,
  TEMPLATE_MAX_FORMS,
  type TemplateSource,
} from '@features/import/template-zip';
import { extractMeta } from '@features/flavor';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import type { ImportDeps } from './import-pkc2';

/** 1 ファイルの上限(展開後)。 */
export const TEMPLATE_FILE_MAX = 1024 * 1024;

/**
 * zip の中身(ファイルだけ)を、**元の zip の名前**で返す(ゴミの行は除く)。
 * 🔴 `unwrapSingleTopDir` が剥がした最上位のフォルダを名前へ戻す ── `template.yaml` を探すのは
 *   「zip の直下」か「ちょうど 1 段下」だけにする(`a/b/template.yaml` を 2 段目として拾わない)。
 */
function originalFiles(raw: Awaited<ReturnType<typeof readZipDirectory>>): Awaited<ReturnType<typeof readZipDirectory>> {
  const u = unwrapSingleTopDir(raw);
  return u.entries.filter((e) => !e.isDirectory).map((e) => ({ ...e, name: u.prefix + e.name }));
}

/** zip が旧版のテンプレートか(中央ディレクトリだけ見る。壊れた zip は false = 従来の断り文へ)。 */
export async function isTemplateZip(file: Blob): Promise<boolean> {
  try {
    return findTemplateRoot(originalFiles(await readZipDirectory(file)).map((e) => e.name)) !== null;
  } catch {
    return false;
  }
}

/** テンプレート zip を取り込む。⚠ 失敗は `fail`(可視)で終え、成功は取り込んだ件数。 */
export async function importTemplateZip(
  deps: ImportDeps,
  file: File,
  fail: (msg: string) => null,
  clearProgress: () => void,
): Promise<number | null> {
  let result;
  try {
    const raw = await readZipDirectory(file);
    const dir = originalFiles(raw);
    const names = dir.map((e) => e.name);
    const prefix = findTemplateRoot(names);
    if (prefix === null) return fail(`「${markName(file.name)}」: template.yaml が見つかりません`);
    // 1 段下に置かれていたときの接頭辞(`X/`)。名前は元の zip のまま(`originalFiles`)
    const rel = (n: string): string => n.slice(prefix.length);
    const mine = dir.filter((e) => e.name.startsWith(prefix));
    const tEntry = mine.find((e) => /^template\.ya?ml$/u.test(rel(e.name)))!;
    const read = async (e: (typeof dir)[number]): Promise<string> => {
      if (e.uncompressedSize > TEMPLATE_FILE_MAX) {
        throw new TemplateImportError(`「${rel(e.name)}」が大きすぎます(${humanBytes(TEMPLATE_FILE_MAX)} まで)`);
      }
      return readZipText(file, e);
    };
    // 🔴 ファイルの数は**読む前に**数えて断る(1 つずつ最大 1MB を読んでから数えない)
    const formEntries = mine.filter((e) => e !== tEntry && /^forms\/[^/]+\.ya?ml$/iu.test(rel(e.name)));
    if (formEntries.length > TEMPLATE_MAX_FORMS) {
      throw new TemplateImportError(`forms/ のファイルが多すぎます(${String(TEMPLATE_MAX_FORMS)} 個まで)`);
    }
    const forms = new Map<string, string>();
    const other: string[] = [];
    for (const e of mine) {
      const r = rel(e.name);
      if (e === tEntry) continue;
      if (/^forms\/[^/]+\.ya?ml$/iu.test(r)) forms.set(r.slice(6), await read(e));
      else other.push(r);
    }
    const src: TemplateSource = { template: await read(tEntry), forms, otherFiles: other };
    result = convertTemplate(src, {
      genLid: deps.genLid,
      genRelationId: deps.genRelationId,
    });
  } catch (e) {
    if (e instanceof TemplateImportError) {
      return fail(`「${markName(file.name)}」: ${oneLine(e.message)}(ノートは 1 件も追加されていません)`);
    }
    if (e instanceof ZipReadError) {
      return fail(`「${markName(file.name)}」を読めませんでした: ${e.message}(ノートは 1 件も追加されていません)`);
    }
    return fail(`テンプレートを読めませんでした(ノートは 1 件も追加されていません): ${errorText(e)}`);
  }
  if (result.notes.length === 0) return fail('テンプレートから取り込めるノートが 1 件も入っていませんでした');

  let order = deps.orderBase();
  const rows: EntryUpsert[] = result.notes.map((n) => {
    const ext = extractMeta(n.archetype, n.body);
    return {
      lid: n.lid,
      title: n.title,
      archetype: n.archetype,
      body: n.body,
      entryOrder: ++order,
      status: ext.status,
      date: ext.date,
      archived: ext.archived,
    };
  });
  let wrote = false;
  try {
    await deps.bulkUpsertEntries(rows);
    wrote = true;
    if (result.relations.length > 0) await deps.bulkUpsertRelations([...result.relations]);
  } catch (e) {
    await deps.reload().catch(() => {});
    if (wrote) deps.imported?.(rows.map((r) => r.lid), { tagColors: false });
    return fail(
      wrote
        ? `ノートまでは取り込みましたが、フォルダへの配置で失敗しました(「取り込みを取り消す」で戻せます): ${errorText(e)}`
        : `取り込みに失敗しました(ノートは 1 件も追加されていません): ${errorText(e)}`,
    );
  }
  await deps.reload();
  const c = result.counts;
  deps.imported?.(rows.map((r) => r.lid), { tagColors: false });
  const first = rows.find((r) => r.archetype !== 'folder');
  if (first) deps.focus?.(first.lid);
  const summary =
    `旧版のテンプレート「${result.name}」を取り込みました: フォルダ ${String(c.folders)} 件・ノート ${String(c.notes)} 件` +
    `(入力欄 ${String(c.forms)}・ログ ${String(c.textlogs)}・テキスト ${String(c.texts)})・入力項目 ${String(c.fields)} 個`;
  const notes = [
    summary,
    ...(result.renamed.length > 0 ? [`項目名を変えました(変換表): ${result.renamed.join(' / ')}`] : []),
    ...result.ignored.map((s) => `取り込まなかった物: ${s}`),
  ];
  deps.report?.(notes);
  clearProgress();
  deps.notify?.(
    `取り込み完了: フォルダ ${String(c.folders)} 件・ノート ${String(c.notes)} 件${result.ignored.length > 0 ? `(取り込まなかった物 ${String(result.ignored.length)} 件)` : ''}`,
  );
  return rows.length;
}
