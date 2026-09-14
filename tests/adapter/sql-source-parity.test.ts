/**
 * 🔴 **選び所に並ぶものは、必ず開ける**(#854 段③)。
 *
 * ## 何を守るのか
 *
 * 「調べる相手」の一覧を組む側(`ui/render/sql.ts` の `paintSource`)と、
 * 「これは何の file か」を決める側(`features/query/sql-guest-source.ts`)は
 * **別の file** である ── ⚠ 片方だけに拡張子を足すと、
 *
 * | 足し忘れた側 | user から見て何が起きるか |
 * |---|---|
 * | 一覧に足して、判定に足さない | **選べるのに、押すと必ず断られる**(無言の dead click に近い) |
 * | 判定に足して、一覧に足さない | **開ける物が、どこからも選べない**(在るのに届かない) |
 *
 * 🔑 CLAUDE.md §7「A と B が合意していること」は、A の test にも B の test にも
 *   書けない ── だから**合意を見る場所をここに 1 つ作る**。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLITE_EXTS, sqlSourcesOf } from '../../src/features/query/sqlite-attachment';
import { csvAttachmentSourcesOf } from '../../src/features/query/csv-attachment';
import { xlsxAttachmentSourcesOf } from '../../src/features/query/xlsx-attachment';
import { SQL_GUEST_EXTS, sqlGuestSourceOf } from '../../src/features/query/sql-guest-source';

const ROOT = join(import.meta.dirname, '../..');
const att = (lid: string, title: string) => ({ lid, title, archetype: 'attachment' });

/**
 * 選び所に並べている一覧(`paintSource` と**同じ 3 本**)。
 * ⚠ ここを手で並べているので、下の「数え上げ」でこの一覧自体の抜けを見る。
 */
const LISTERS = [sqlSourcesOf, csvAttachmentSourcesOf, xlsxAttachmentSourcesOf];

/** 添付として在りうる題名(選び所に出る物と、出ない物の両方)。 */
const NAMES = [
  '売上.sqlite',
  '会員.db',
  '客.csv',
  '客.tsv',
  '台帳.xlsx',
  '台帳.XLSX',
  // ⚠ 出てはいけない物(対照群)
  '古い台帳.xls',
  'ねこ.png',
  'メモ.md',
];

function listed(name: string): boolean {
  const metas = [att('x', name)];
  return LISTERS.some((f) => f(metas).length > 0);
}

describe('選び所と開き方が食い違わない', () => {
  it('🔴 選び所に並んだ物は、必ずどれかの読み方で開ける', () => {
    const bad: string[] = [];
    for (const name of NAMES) {
      if (!listed(name)) continue;
      const src = sqlGuestSourceOf('x', name);
      // ⚠ `null` = 「`.sqlite` の image としてそのまま開く」既定の道 ──
      //    その道へ落ちてよいのは、本当に sqlite 系の拡張子のときだけである
      const ok =
        src !== null || SQLITE_EXTS.some((e) => name.trim().toLowerCase().endsWith(e));
      if (!ok) bad.push(name);
    }
    expect(bad, `選べるのに開き方が決まらない: ${bad.join(' / ')}`).toEqual([]);
  });

  it('🔴 開き方が決まる物は、必ず選び所に並ぶ(在るのに届かない、を作らない)', () => {
    const bad: string[] = [];
    for (const name of NAMES) {
      if (sqlGuestSourceOf('x', name) === null) continue;
      if (!listed(name)) bad.push(name);
    }
    expect(bad, `開けるのにどこからも選べない: ${bad.join(' / ')}`).toEqual([]);
  });

  it('⚠ 空振り防止 ── この corpus には、両側が偽になる物が本当に混じっている', () => {
    // ⚠ 全部が「並ぶし開ける」だと、上の 2 本は**何も主張していない**
    const neither = NAMES.filter((n) => !listed(n) && sqlGuestSourceOf('x', n) === null);
    expect(neither, '対照群(並ばないし開けない物)が 1 つも無い').toContain('ねこ.png');
    // 🔴 `.xls` は**わざと**どちらにも入れていない(zip ではないので開けない)
    expect(neither, '.xls を受けてしまっている').toContain('古い台帳.xls');
    // 対照群のもう片側 ── ちゃんと並んで開ける物も在る
    expect(NAMES.filter((n) => listed(n)).length).toBeGreaterThanOrEqual(6);
  });
});

describe('file 選択画面に出す拡張子と、開き方が食い違わない', () => {
  it('🔴 `accept` に出す拡張子は、全部ほんとうに開ける', () => {
    const bad = SQL_GUEST_EXTS.filter((ext) => {
      const name = `手元の一覧${ext}`;
      // ⚠ `null` = sqlite の既定の道 ── そこへ落ちてよいのは sqlite 系だけ
      return sqlGuestSourceOf('x', name) === null && !SQLITE_EXTS.some((e) => ext === e);
    });
    expect(bad, `選べるのに開き方が決まらない拡張子: ${bad.join(' / ')}`).toEqual([]);
  });

  it('🔴 開ける拡張子は、全部 `accept` に出ている(在るのに選べない、を作らない)', () => {
    // ⚠ **corpus の側から数える** ── 判定が受ける形を並べて、accept に居るか見る
    const openable = NAMES.filter((n) => sqlGuestSourceOf('x', n) !== null || listed(n));
    const bad = openable.filter(
      (n) => !SQL_GUEST_EXTS.some((e) => n.trim().toLowerCase().endsWith(e)),
    );
    expect(bad, `開けるのに file 選択画面に出てこない: ${bad.join(' / ')}`).toEqual([]);
  });

  it('⚠ 空振り防止 ── `accept` の一覧は本当に中身を持っている', () => {
    expect(SQL_GUEST_EXTS.length).toBeGreaterThanOrEqual(6);
    expect(SQL_GUEST_EXTS, '.xlsx が入っていない').toContain('.xlsx');
    // 🔴 `.xls` は**わざと入れない**(zip ではないので開けない)
    expect(SQL_GUEST_EXTS, '.xls を出してしまっている').not.toContain('.xls');
  });
});

describe('数え上げ ── 一覧を組む口を足したら、選び所へも足す', () => {
  it('🔴 `features/query` の `…SourcesOf` は、全部 sql.ts の選び所に繋がっている', () => {
    const dir = join(ROOT, 'src/features/query');
    const found = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/export function (\w*[sS]ourcesOf)\s*\(/g)) {
        found.add(m[1]!);
      }
    }
    expect(found.size, '`…SourcesOf` を 1 つも見つけていない(走査が空振り)').toBeGreaterThan(0);
    // ⚠ 見るのは**実行する行**(注釈に名前を書いても満たされない)
    const sql = readFileSync(join(ROOT, 'src/adapter/ui/render/sql.ts'), 'utf8');
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    const missing = [...found].filter((n) => !code.includes(`${n}(state.entryMetas.values())`));
    expect(
      missing,
      `一覧を組む口が選び所に繋がっていない(足したのに並ばない): ${missing.join(' / ')}`,
    ).toEqual([]);
    // ⚠ 手で並べた LISTERS も同じ数だけ持っていること(この test 自身の腐り止め)
    expect(LISTERS.length, 'この test の LISTERS が実装に追いついていない').toBe(found.size);
  });
});
