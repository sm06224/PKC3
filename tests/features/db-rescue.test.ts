/** @vitest-environment happy-dom */
/**
 * 🔴 **壊れた DB の報告を読み解く**(#971 段③)。
 *
 * ⚠ ここの fixture は**実測した字**である ── 2026-09-16 に同梱の sqlite 3.53.0 へ
 *   壊した DB(4000 行 / `page_size` 8192)を作って当て、返ってきた行をそのまま置いた。
 * 🔑 **推測で作った字で試さない** ── 形が 1 つ違うだけで、
 *   「壊れているのに無事と言う」側へ倒れる(CLAUDE.md §8)。
 */
import { describe, expect, it } from 'vitest';
import {
  integritySummary,
  parseQuickCheck,
  rescueSummary,
  type SchemaRoot,
} from '../../src/features/storage/db-rescue';
import { RESCUE_ARCHIVE_LABEL } from '../../src/features/storage/rescue-labels';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';

/** 実測した schema(root page → 何の木か)。 */
const SCHEMA: SchemaRoot[] = [
  { type: 'table', name: 'relations', rootpage: 2 },
  { type: 'index', name: 'sqlite_autoindex_relations_1', rootpage: 3 },
  { type: 'index', name: 'idx_rel_from', rootpage: 4 },
  { type: 'index', name: 'idx_rel_to', rootpage: 5 },
];

/** 🔴 実測: **表**(root 2)を壊したときの 1 行目(改行込みで返る)。 */
const TABLE_BROKEN = [
  '*** in database main ***\n' +
    'Tree 2 page 2 cell 27: Offset 23130 out of range 8024..8188\n' +
    'Tree 2 page 2 cell 26: Offset 23130 out of range 8024..8188',
];

/** 🔴 実測: **名前つきの索引**(root 4)を壊すと、2 行で返る。 */
const INDEX_BROKEN = [
  '*** in database main ***\n' +
    'Tree 4 page 4 cell 7: Offset 23130 out of range 8039..8188\n' +
    'Tree 4 page 4 cell 6: Offset 23130 out of range 8039..8188',
  'wrong # of entries in index idx_rel_from',
];

describe('quick_check の報告を読む(#971 段③)', () => {
  it('🔴 健全なときは ok(実測: 行は "ok" の 1 つだけ)', () => {
    const r = parseQuickCheck(['ok'], SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.brokenTables).toEqual([]);
    expect(r.brokenIndexes).toEqual([]);
  });

  /**
   * ⚠ **`ok` を `includes` で見ない** ── 壊れの説明に `ok` の字が混じったときに
   *   「無事」と読んでしまう(§1「代替物で満たせない条件にする」)。
   */
  it('🔴 説明文に ok の字が混じっても、無事とは言わない', () => {
    const r = parseQuickCheck(['*** in database main ***\nTree 2 page 2 cell 0: not ok'], SCHEMA);
    expect(r.ok, '壊れているのに無事と読んだ').toBe(false);
    expect(r.brokenTables).toEqual(['relations']);
  });

  it('🔴 表が壊れていたら、表の名前で言う', () => {
    const r = parseQuickCheck(TABLE_BROKEN, SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.brokenTables).toEqual(['relations']);
    // ⚠ 対照群 ── 表が壊れただけで索引の名前を並べない(嘘の範囲を出さない)
    expect(r.brokenIndexes, '表の壊れを索引のせいにした').toEqual([]);
  });

  it('🔴 索引だけが壊れていたら、表は無傷として扱う', () => {
    const r = parseQuickCheck(INDEX_BROKEN, SCHEMA);
    expect(r.ok).toBe(false);
    // 🔑 ここが本題 ── 表を巻き込むと「本文が壊れた」と誤って伝える
    expect(r.brokenTables, '索引の壊れを本文のせいにした').toEqual([]);
    expect(r.brokenIndexes).toEqual(['idx_rel_from']);
  });

  /**
   * 🔴 **`Page <N>: never used` の N は root page ではない**(実測で並んで出る)。
   * ⚠ これを木の番号として読むと、**無関係な表を名指しする**。
   */
  it('🔴 「Page N: never used」を木の名前に使わない', () => {
    const r = parseQuickCheck(
      ['*** in database main ***\nPage 2: never used\nPage 4: never used'],
      SCHEMA,
    );
    expect(r.brokenTables, 'ただの page 番号を root と読んだ').toEqual([]);
    expect(r.brokenIndexes, 'ただの page 番号を root と読んだ').toEqual([]);
    // ⚠ 捨てない ── 分からなかった行は残して、画面に出す
    expect(r.unresolved.length, '分からない行を黙って捨てた').toBe(2);
  });

  it('⚠ schema が読めないときは、名指しせずに残す', () => {
    const r = parseQuickCheck(TABLE_BROKEN, []);
    expect(r.brokenTables).toEqual([]);
    expect(r.unresolved.some((l) => l.includes('Tree 2 page 2')), '行ごと消えた').toBe(true);
  });

  it('⚠ 1 行に改行で詰まった報告を、全部読む(1 件目だけ見ない)', () => {
    const r = parseQuickCheck(
      [
        '*** in database main ***\n' +
          'Tree 4 page 4 cell 1: bad\n' +
          'Tree 5 page 5 cell 1: bad\n' +
          'Tree 2 page 2 cell 1: bad',
      ],
      SCHEMA,
    );
    expect(r.brokenIndexes).toEqual(['idx_rel_from', 'idx_rel_to']);
    expect(r.brokenTables).toEqual(['relations']);
  });
});

describe('画面に出す字(#971 段③)', () => {
  const noMarkup = (s: string): void => {
    // ⚠ お知らせと同じ作法 ── この面は textContent なので記法はそのまま字として出る
    expect(s, `記法が混じっている: ${s}`).not.toMatch(/[*`_]|\[.*\]\(.*\)/);
  };

  /**
   * 🔴 **押させる字が、画面に実在するか**(2026-09-18 に直した。#996 と同じ型)。
   *
   * ⚠ 直す前この検査は **`'拾えるだけ取り出す'` を手で書いて**いた ── そして
   *   🔴 **その字は 2026-09-16(#986)に画面から消えていた**(口が 2 つに割れた)。
   *   つまり **DB が本当に壊れた人にだけ出る 1 行が行き止まり**なのに、
   *   検査は**その行き止まりを pin していた**(両方そのままで緑になる)。
   * 🔑 だから**期待値を手で書かない** ── 描いたボタンの字(= 独立した観測)と突き合わせる。
   */
  const onScreenLabels = (): string[] => {
    const box = buildSettingsCommands();
    return [...box.querySelectorAll('button')].map(
      (b) => b.querySelector('[data-pkc-field="label"]')?.textContent ?? b.textContent ?? '',
    );
  };

  /** 字の中の 「…」 を全部抜く ── user に押させている名前はこれである。 */
  const quoted = (s: string): string[] => [...s.matchAll(/「([^」]+)」/g)].map((m) => m[1] ?? '');

  it('🔴 索引だけのときは「中身は無事かもしれない」と言い、次の一手を書く', () => {
    const s = integritySummary(parseQuickCheck(INDEX_BROKEN, SCHEMA));
    expect(s).toContain('目次');
    expect(s, '次に何を押すか書いていない').toContain(RESCUE_ARCHIVE_LABEL);
    noMarkup(s);
  });

  it('🔴 表のときは「一部だけ」と正直に言う', () => {
    const s = integritySummary(parseQuickCheck(TABLE_BROKEN, SCHEMA));
    expect(s).toContain('一部');
    expect(s, '次に何を押すか書いていない').toContain(RESCUE_ARCHIVE_LABEL);
    noMarkup(s);
  });

  /**
   * 🔴 **これが本体の門である** ── 上の 2 つは「定数と一致するか」しか見ていない。
   * 🔑 ここは **定数が画面に本当に在るか**まで見る(定数だけ直して描画をやめても鳴る)。
   */
  it('🔴 断りの字が押させるボタンは、1 つ残らず画面に在る', () => {
    const labels = onScreenLabels();
    // ⚠ 空振り防止 ── 設定の面からボタンを引けていなければ、この検査は何も見ていない
    expect(labels.length, '設定の面からボタンを 1 つも引けていない').toBeGreaterThan(5);

    const all = [
      integritySummary(parseQuickCheck(INDEX_BROKEN, SCHEMA)),
      integritySummary(parseQuickCheck(TABLE_BROKEN, SCHEMA)),
      // 🔑 **どこが壊れたか分からなかった枝**も見る ── ここも 3 つ目の行き止まりだった
      integritySummary({
        ok: false,
        brokenTables: [],
        brokenIndexes: [],
        unresolved: ['Tree 9 page 9 cell 0: bad'],
        lines: [],
        truncated: false,
      }),
    ];
    const names = [...new Set(all.flatMap(quoted))];
    // ⚠ 空振り防止 ── 1 つも押させていないなら「次の一手が無い」ということである
    expect(names.length, '断りの字が、押す所を 1 つも言っていない').toBeGreaterThan(0);
    for (const n of names) {
      expect(labels, `画面に無い字を押させている: 「${n}」`).toContain(n);
    }
  });

  it('⚠ 無事なときは、余計な不安を足さない', () => {
    const s = integritySummary(parseQuickCheck(['ok'], SCHEMA));
    expect(s).toContain('見つかりませんでした');
    expect(s, '無事なのに取り出せと言った').not.toContain('取り出す');
  });

  /**
   * 🔴 **拾えた件数を「全部」と読ませない**(実測: 壊れているときほど
   *   「空で返る区画」が増える ── 区切り 100 行で 38/40)。
   */
  it('🔴 読み飛ばした所があるなら、必ずそう言う', () => {
    const s = rescueSummary({ rows: 120, skipped: 3, empty: 38 });
    expect(s).toContain('120');
    expect(s, '全部拾えたかのように読める').toContain('全部とは限りません');
    noMarkup(s);
  });

  it('⚠ 読み飛ばしが 0 のときは、余計な但し書きを付けない', () => {
    const s = rescueSummary({ rows: 120, skipped: 0, empty: 0 });
    expect(s).toContain('ありません');
    expect(s).not.toContain('限りません');
  });

  it('⚠ 1 件も拾えなかったときは、別の言い方をする', () => {
    const s = rescueSummary({ rows: 0, skipped: 40, empty: 0 });
    expect(s).toContain('1 件も');
    noMarkup(s);
  });
});
