/**
 * 🔴 **ノート内データフロー:DAG・循環・最小の評価計画・入力の指紋**(#2115 PR-2)。
 *
 * 守る主張:
 * 1. 多段のビュー(A + B → V1 → V2)を評価の順に並べる(同順位は定義順)
 * 2. 文字列・注釈の中の名前、CTE、列の別名は依存の辺にしない(起きていない循環を言わない)
 * 3. 直接・間接の循環を鎖で返し、その下流は評価しない
 * 4. 改名・削除で消えた名前は、候補の名前つきの 1 文で言う
 * 5. 計画は推移的に要る物だけ(無関係な表・ビューを含めない)
 * 6. 指紋は決定論的で、無関係な段落では変わらず、上流の中身・SQL で必ず変わる
 */
import { describe, expect, it } from 'vitest';
import {
  buildNoteDataflow,
  computeDataflowHash,
  formatMissingSourceError,
  planViewEvaluation,
  type ViewEvaluationPlanOk,
} from '../../../src/features/dataflow';

const F = '```';
const body = (...lines: string[]): string => lines.join('\n');
const view = (name: string, sql: string, extra = ''): string[] => [`${F}sql view=${name}${extra}`, sql, F];
const csv = (name: string, ...rows: string[]): string[] => [`${F}csv name=${name}`, ...rows, F];
const okPlan = (body_: string, target: string): ViewEvaluationPlanOk => {
  const p = planViewEvaluation(buildNoteDataflow(body_), target);
  if (!p.ok) throw new Error(p.error);
  return p;
};

/** A + B → V1 → V2 と、無関係な C / U。 */
const multi = body(
  '# 売上の分析',
  ...csv('A', 'id,金額', '1,100', '2,200'),
  '%% dataset: B %%',
  '| id | 地域 |',
  '|---|---|',
  '| 1 | 東 |',
  ...csv('C', 'x', '9'),
  ...view('V2', 'SELECT 地域, count(*) FROM V1 GROUP BY 地域'),
  ...view('V1', 'SELECT * FROM A JOIN B USING (id)'),
  ...view('U', 'SELECT * FROM C'),
);

describe('DAG と評価の順', () => {
  it('多段のビューをトポロジカル順に並べる(定義順では V2 が先でも V1 が先)', () => {
    const g = buildNoteDataflow(multi);
    expect(g.diagnostics).toEqual([]);
    expect([...g.datasets.keys()]).toEqual(['A', 'B', 'C']);
    expect([...g.views.keys()]).toEqual(['V2', 'V1', 'U']);
    expect(g.order).toEqual(['V1', 'V2', 'U']);
    expect(g.views.get('V1')?.deps).toEqual(['A', 'B']);
    expect(g.views.get('V2')?.deps).toEqual(['V1']);
    expect(g.cycles).toEqual([]);
  });

  it('🔴 文字列リテラル・注釈の中の名前は依存にしない', () => {
    const g = buildNoteDataflow(
      body(...csv('A', 'x', '1'), ...csv('B', 'x', '2'), ...view('V', "SELECT 'B' AS 字 /* B */ FROM A -- B")),
    );
    expect(g.views.get('V')?.deps).toEqual(['A']);
  });

  it('🔴 WITH の CTE がデータセットと同じ名前なら、そのデータセットは依存ではない', () => {
    const g = buildNoteDataflow(
      body(...csv('A', 'x', '1'), ...view('V', 'WITH A AS (SELECT 1 AS x) SELECT * FROM A')),
    );
    expect(g.views.get('V')?.deps).toEqual([]);
    expect(g.views.get('V')?.missingRefs).toEqual([]);
  });

  it('🔴 列の別名がビューと同じ名前でも循環にしない(sql view=合計 … AS 合計)', () => {
    const g = buildNoteDataflow(
      body(
        ...csv('売上', '金額', '1'),
        ...view('合計', 'SELECT sum(金額) AS 合計 FROM 売上'),
        ...view('件数', 'SELECT count(*) AS 合計 FROM 売上'),
      ),
    );
    expect(g.cycles).toEqual([]);
    expect(g.order).toEqual(['合計', '件数']);
  });

  it('ASCII の大小を畳んで辺を張る(綴りは定義の方)', () => {
    const g = buildNoteDataflow(body(...csv('Sales', 'x', '1'), ...view('v1', 'SELECT * FROM sales'), ...view('V2', 'SELECT * FROM V1')));
    expect(g.views.get('v1')?.deps).toEqual(['Sales']);
    expect(g.views.get('V2')?.deps).toEqual(['v1']);
    expect(g.order).toEqual(['v1', 'V2']);
  });

  it('自動候補(添付リンク)はビューの名前に譲る', () => {
    const g = buildNoteDataflow(body('[V.csv](asset:k1) [D.csv](asset:k2)', ...view('V', 'SELECT * FROM D')));
    expect([...g.datasets.keys()]).toEqual(['D']);
    expect(g.views.get('V')?.deps).toEqual(['D']);
  });

  it('同順位は定義順(独立したビュー)', () => {
    const g = buildNoteDataflow(body(...view('z', 'SELECT 1'), ...view('a', 'SELECT 2'), ...view('m', 'SELECT 3')));
    expect(g.order).toEqual(['z', 'a', 'm']);
  });
});

describe('循環', () => {
  it('🔴 直接の循環(a → a)', () => {
    const g = buildNoteDataflow(body(...view('a', 'SELECT * FROM a')));
    expect(g.cycles).toEqual([['a', 'a']]);
    expect(g.order).toEqual([]);
    expect(g.diagnostics).toEqual([expect.objectContaining({ kind: 'cycle', name: 'a', line: 0 })]);
    expect(g.diagnostics[0]?.why).toContain('a → a');
  });

  it('🔴 間接の循環(a → b → c → a)と、その下流(d)は評価しない・無関係な e は評価する', () => {
    const g = buildNoteDataflow(
      body(
        ...view('a', 'SELECT * FROM b'),
        ...view('b', 'SELECT * FROM c'),
        ...view('c', 'SELECT * FROM a'),
        ...view('d', 'SELECT * FROM c'),
        ...view('e', 'SELECT 1'),
      ),
    );
    expect(g.cycles).toEqual([['a', 'b', 'c', 'a']]);
    expect(g.order).toEqual(['e']);
    const kinds = g.diagnostics.map((d) => [d.kind, d.name]);
    expect(kinds).toEqual([
      ['cycle', 'a'],
      ['cycle', 'b'],
      ['cycle', 'c'],
      ['blocked', 'd'],
    ]);
    const pa = planViewEvaluation(g, 'b');
    expect(pa.ok).toBe(false);
    if (!pa.ok) expect(pa.error).toContain('a → b → c → a');
    const pd = planViewEvaluation(g, 'd');
    expect(pd.ok).toBe(false);
    if (!pd.ok) expect(pd.error).toContain('循環');
    expect(planViewEvaluation(g, 'e').ok).toBe(true);
  });

  it('2 つの別々の循環を両方返す(定義順)', () => {
    const g = buildNoteDataflow(
      body(...view('x', 'SELECT * FROM y'), ...view('y', 'SELECT * FROM x'), ...view('s', 'SELECT * FROM s')),
    );
    expect(g.cycles).toEqual([
      ['x', 'y', 'x'],
      ['s', 's'],
    ]);
  });
});

describe('名前が見つからない(改名・削除)', () => {
  it('🔴 未解決の参照を候補の名前つきで言う', () => {
    const g = buildNoteDataflow(body(...csv('新売上', 'x', '1'), ...view('V', 'SELECT * FROM 旧売上')));
    expect(g.views.get('V')?.missingRefs).toEqual(['旧売上']);
    const d = g.diagnostics.find((x) => x.kind === 'missing-ref');
    expect(d).toMatchObject({ name: 'V', line: 4 });
    expect(d?.why).toBe(
      'ビュー「V」: データセットまたはビュー「旧売上」が見つかりません。このノートで利用可能な名前: 新売上、V',
    );
  });

  it('PKC の内部の表(entries など)は未解決と言わない', () => {
    const g = buildNoteDataflow(body(...view('V', 'SELECT count(*) FROM entries')));
    expect(g.diagnostics).toEqual([]);
  });

  it('利用できる名前が 0 件なら、その旨を言う', () => {
    const empty = buildNoteDataflow('ただの本文');
    expect(formatMissingSourceError('売上', empty)).toBe(
      'データセットまたはビュー「売上」が見つかりません。このノートには利用できるデータセット・ビューがありません(表に名前を付けると使えます)',
    );
    const p = planViewEvaluation(empty, '売上');
    expect(p).toEqual({ ok: false, error: formatMissingSourceError('売上', empty) });
  });
});

describe('最小の評価計画(planViewEvaluation)', () => {
  it('🔴 V2 には A / B / V1 / V2 だけ(C / U は含めない)', () => {
    const p = okPlan(multi, 'V2');
    expect(p.target).toBe('V2');
    expect(p.targetKind).toBe('view');
    expect(p.datasets.map((d) => d.name)).toEqual(['A', 'B']);
    expect(p.views.map((v) => v.name)).toEqual(['V1', 'V2']);
  });

  it('U には C だけ', () => {
    const p = okPlan(multi, 'U');
    expect(p.datasets.map((d) => d.name)).toEqual(['C']);
    expect(p.views.map((v) => v.name)).toEqual(['U']);
  });

  it('データセットを対象にすればそれ 1 つ(大小を畳んで引く)', () => {
    const p = okPlan(multi, 'a');
    expect(p).toMatchObject({ target: 'A', targetKind: 'dataset', views: [] });
    expect(p.datasets.map((d) => d.name)).toEqual(['A']);
  });
});

describe('入力の指紋(computeDataflowHash)', () => {
  const hashOf = (b: string, target = 'V2', fp?: ReadonlyMap<string, string>): string =>
    computeDataflowHash(okPlan(b, target), fp);

  it('決定論的(同じ本文から同じ字・SHA-256 の hex 64 字)', () => {
    expect(hashOf(multi)).toBe(hashOf(multi));
    expect(hashOf(multi)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('🔴 無関係な段落・無関係な表・無関係なビューを変えても変わらない', () => {
    const base = hashOf(multi);
    expect(hashOf(`段落を足した\n\n${multi}\n\n末尾にも`)).toBe(base);
    expect(hashOf(multi.replace('9', '999'))).toBe(base); // C の値
    expect(hashOf(multi.replace('SELECT * FROM C', 'SELECT 1 FROM C'))).toBe(base); // U の SQL
    expect(hashOf(multi.replace('sql view=V2', 'sql view=V2 embed'))).toBe(base); // 結果を出すかどうか
  });

  it('🔴 上流のデータセットの値・上流のビューの SQL・対象の SQL で必ず変わる', () => {
    const base = hashOf(multi);
    expect(hashOf(multi.replace('1,100', '1,101'))).not.toBe(base); // A の値
    expect(hashOf(multi.replace('| 1 | 東 |', '| 1 | 西 |'))).not.toBe(base); // B の値
    expect(hashOf(multi.replace('id,金額', 'id,売値'))).not.toBe(base); // A の列名
    expect(hashOf(multi.replace('JOIN B USING', 'LEFT JOIN B USING'))).not.toBe(base); // V1
    expect(hashOf(multi.replace('count(*)', 'count(1)'))).not.toBe(base); // V2
  });

  it('添付は鍵と指紋で変わる', () => {
    const b = body('<!-- dataset: D=asset:k1 -->', ...view('V2', 'SELECT * FROM D'));
    const fp1 = new Map([['k1', 'aaa']]);
    const fp2 = new Map([['k1', 'bbb']]);
    expect(hashOf(b, 'V2', fp1)).toBe(hashOf(b, 'V2', fp1));
    expect(hashOf(b, 'V2', fp1)).not.toBe(hashOf(b, 'V2', fp2));
    expect(hashOf(b, 'V2', fp1)).not.toBe(hashOf(b.replace('k1', 'k2'), 'V2', new Map([['k2', 'aaa']])));
    expect(hashOf(b)).not.toBe(hashOf(b, 'V2', fp1)); // 指紋が無い ⇄ 在る
  });
});
