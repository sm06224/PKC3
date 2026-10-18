/**
 * 🔴 **操作の全数台帳を、構造不変量で守る**(#582 段①)。
 *
 * UI のボタン(`data-pkc-action`)やコマンドを 1 つ足すたびにハードコードされた件数で
 * 落ちるのを防ぎつつ、以下の本質的な不変量を検査する:
 * 1. `total === receivers + outsideActionsTable.length` / `receivers === both + unregistered`
 * 2. 受け手は全員 `arg` 種別を持ち、登記簿の項目は全員 `label` を持つ
 * 3. id 空間の混在(`!receiver && screens.length > 0`)が 0 件
 * 4. 橋(`SHORTCUT_BUTTON` / `FORMAT_OF`)で繋がる登記がすべて有効な形式を持つ
 * 5. 未登記の一覧(`unregisteredList`)が `P1` と `nameable` を正しく分離し、押し所の `file:line` を 80% 以上引ける
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { registries, summary, table, unregisteredList } from '../scripts/operation-table.mjs';

interface Row {
  id: string;
  receiver: boolean;
  books: string[];
  label: string | null;
  arg: string | null;
  screens: string[];
  bridge: string | null;
}
interface Summary {
  total: number;
  receivers: number;
  registered: number;
  both: number;
  outsideActionsTable: { id: string; bridge: string | null }[];
  unbridged: string[];
  unregistered: number;
  scanned: number;
  sharedBooks: { id: string; books: string[] }[];
  perBook: Record<string, number>;
}
const s = (): Summary => (summary as () => Summary)();
const rows = (): Row[] => (table as () => Row[])();
const reg = (): Record<string, { id: string }[]> =>
  (registries as () => Record<string, { id: string }[]>)();

describe('操作の全数台帳(#582 段①)', () => {
  it('🔴 台帳の集合演算の不変量が成立し、空振りしていない', () => {
    const x = s();
    expect(x.receivers).toBeGreaterThanOrEqual(350);
    expect(x.registered).toBeGreaterThanOrEqual(150);
    expect(x.both).toBeGreaterThanOrEqual(90);
    expect(x.receivers).toBe(x.both + x.unregistered);
    expect(x.registered).toBe(x.both + x.outsideActionsTable.length);
    expect(x.total).toBe(x.receivers + x.outsideActionsTable.length);
  });

  it('🔴 複数の登記簿に跨る id に必須の共有操作が含まれている', () => {
    const shared = new Map(s().sharedBooks.map((r) => [r.id, r.books]));
    expect(shared.get('copy-entry-link')).toEqual(['key', 'entry']);
    expect(shared.get('cycle-read-columns')).toEqual(['key', 'body']);
    expect(shared.get('open-note-window')).toEqual(['key', 'entry', 'body']);
  });

  it('🔴 6 つの登記簿すべてが空でなく、合計が perBook と一致する', () => {
    const pb = s().perBook;
    expect(Object.keys(pb).sort()).toEqual(
      ['body', 'collection', 'collectionPane', 'entry', 'key', 'settings'].sort(),
    );
    for (const [k, count] of Object.entries(pb)) {
      expect(count, `${k} が空`).toBeGreaterThan(0);
    }
  });

  it('🔴 押し所へ辿れない登記(unbridged)はすべて outsideActionsTable の部分集合である', () => {
    const outsideNull = s()
      .outsideActionsTable.filter((r) => r.bridge === null)
      .map((r) => r.id)
      .sort();
    expect([...s().unbridged].sort()).toEqual(outsideNull);
    expect(outsideNull.length).toBeGreaterThan(20);
  });

  it('橋で繋がっている登記は、選択子か記法として辿れる', () => {
    const outside = s().outsideActionsTable.filter((r) => r.bridge !== null);
    expect(outside.length).toBeGreaterThanOrEqual(15);
    for (const r of outside) {
      expect(r.bridge === 'format' || (r.bridge ?? '').startsWith('button:[')).toBe(true);
    }
  });

  it('🔴 空振り防止: 受け手は全員 種別を持ち、登記は全員 字を持つ', () => {
    const all = rows();
    expect(all.filter((r) => r.receiver && r.arg === null)).toEqual([]);
    expect(all.filter((r) => r.books.length > 0 && r.label === null)).toEqual([]);
    for (const [name, list] of Object.entries(reg())) {
      expect(list.length, `${name} が空`).toBeGreaterThan(0);
    }
  });

  it('🔴 id 空間が混ざり始めたら鳴る(いまは 0 件)', () => {
    expect(rows().filter((r) => !r.receiver && r.screens.length > 0)).toEqual([]);
    expect(rows().filter((r) => r.receiver && r.screens.length > 0).length).toBeGreaterThan(100);
    expect(s().scanned).toBe(s().total);
  });

  it('🔴 未登記の一覧(--unregistered)が summary と一致し、P1 と nameable を正しく分け、押し所を引ける', () => {
    type U = { id: string; arg: string | null; nameable: boolean; sites: { at: string }[] };
    const un = rows().filter((r) => r.receiver && r.books.length === 0);
    expect(un.length, '未登記の数え方が summary と食い違っている').toBe(s().unregistered);

    const list = (unregisteredList as () => U[])();
    expect(list.map((r) => r.id).sort()).toEqual(un.map((r) => r.id).sort());
    for (const r of list) {
      expect(r.nameable).toBe(r.arg !== 'P1');
    }
    const sited = list.filter((r) => r.sites.length > 0);
    expect(sited.length, '押し所が引けた数').toBeGreaterThan(list.length * 0.8);
    for (const r of sited) {
      for (const x of r.sites) expect(x.at, `${r.id} の押し所`).toMatch(/^[a-z0-9/.-]+\.ts:\d+$/);
    }
  });
});
