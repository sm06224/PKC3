/**
 * #2002 段 3: 無印テンプレート zip の取込(入口は `importPkc2File`)。
 * zip は tests/fixtures/pkc-templates/ の実物から組む。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { importPkc2File, type ImportDeps } from '../../src/adapter/ui/actions/import-pkc2';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { buildZip, bytesOf, type FixtureEntry } from '../features/zip-fixture';
import { parseFormDef } from '../../src/features/markdown/form-def';

const ROOT = join(__dirname, '..', 'fixtures', 'pkc-templates');

function walk(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, `${base}${n}/`) : [`${base}${n}`];
  });
}

async function templateZip(name: string, prefix = ''): Promise<File> {
  const entries: FixtureEntry[] = walk(join(ROOT, name)).map((f) => ({
    name: prefix + f,
    bytes: bytesOf(readFileSync(join(ROOT, name, f), 'utf8')),
  }));
  return new File([await buildZip(entries)], `${name}.zip`);
}

function harness() {
  const written: EntryUpsert[] = [];
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  const notices: string[] = [];
  let reported: readonly string[] = [];
  let n = 0;
  const imported: string[][] = [];
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  const deps = {
    existingLids: async () => new Set<string>(),
    existingRelationIds: () => new Set<string>(),
    orderBase: () => 0,
    genLid: () => `lid-${String(++n)}`,
    genAssetKey: () => `ast-${String(++n)}`,
    genRelationId: () => `rel-${String(++n)}`,
    bulkUpsertEntries: async (e: EntryUpsert[]) => void written.push(...e),
    bulkUpsertRelations: async (r: typeof relations) => void relations.push(...r),
    listStoredBlobKeys: async () => new Set<string>(),
    reload: async () => {},
    notify: (m: string) => void notices.push(m),
    report: (x: readonly string[]) => void (reported = x),
    imported: (l: readonly string[]) => void imported.push([...l]),
  } as unknown as ImportDeps;
  return { d, deps, written, relations, notices, imported, reported: () => reported };
}

describe('無印テンプレート zip の取込', () => {
  it.each([
    ['qa-regression', 3, 4, 10],
    ['ops-handoff', 3, 4, 9],
    ['product-discovery', 3, 3, 6],
  ])('%s: フォルダ %i・ノート %i・項目 %i を作り、結果に件数と取り込まなかった物を出す', async (name, folders, notes, fields) => {
    const h = harness();
    expect(await importPkc2File(h.d, h.deps, await templateZip(name))).toBe(folders + notes);
    expect(h.written.filter((e) => e.archetype === 'folder')).toHaveLength(folders);
    expect(h.written.filter((e) => e.archetype !== 'folder')).toHaveLength(notes);
    expect(h.written.map((e) => e.entryOrder)).toEqual(h.written.map((_, i) => i + 1));
    expect(h.relations.every((r) => r.kind === 'structural')).toBe(true);
    // 本文は JSON ではなくふつうの Markdown
    expect(h.written.every((e) => !e.body.trimStart().startsWith('{'))).toBe(true);
    let total = 0;
    for (const e of h.written) {
      const m = /```yaml form\n([\s\S]*?)\n```/u.exec(e.body);
      if (m !== null) total += parseFormDef(m[1]!).fields.length;
    }
    expect(total).toBe(fields);
    const rep = h.reported();
    expect(rep[0]).toContain(`フォルダ ${String(folders)} 件・ノート ${String(notes)} 件`);
    expect(rep[0]).toContain(`入力項目 ${String(fields)} 個`);
    expect(rep.slice(1).every((l) => l.startsWith('取り込まなかった物: '))).toBe(true);
    expect(h.imported).toHaveLength(1);
  });

  it('ops-handoff の取り込まなかった物は trust_level / capabilities / assets / snippets / flag を含む', async () => {
    const h = harness();
    await importPkc2File(h.d, h.deps, await templateZip('ops-handoff'));
    const joined = h.reported().join('\n');
    for (const w of ['meta.trust_level', 'meta.required_capabilities', 'assets/', 'snippets/', 'flag「warn」']) expect(joined).toContain(w);
    expect(h.notices.at(-1)).toBe('取り込み完了: フォルダ 3 件・ノート 4 件(取り込まなかった物 6 件)');
  });

  it('フォルダごと zip にした(1 段下の)テンプレートも読める', async () => {
    const h = harness();
    expect(await importPkc2File(h.d, h.deps, await templateZip('qa-regression', 'qa-regression/'))).toBe(7);
  });

  it('壊れた YAML は 1 件も書かずに断る', async () => {
    const h = harness();
    const zip = await buildZip([
      { name: 'template.yaml', bytes: bytesOf('entries:\n  - type: text\n    title: a\n    body: !!js/function x\n') },
    ]);
    h.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    expect(await importPkc2File(h.d, h.deps, new File([zip], 't.zip'))).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error).toMatch(/template\.yaml を読めませんでした.*タグ.*1 件も追加されていません/);
  });

  it('template.yaml の無い zip は従来どおり断る(対照群)', async () => {
    const h = harness();
    const zip = await buildZip([{ name: 'body.md', bytes: bytesOf('# x\n') }]);
    expect(await importPkc2File(h.d, h.deps, new File([zip], 'x.zip'))).toBeNull();
    expect(h.written).toHaveLength(0);
    expect(h.d.getState().error).toMatch(/PKC の書き出しではない zip/);
  });
});
