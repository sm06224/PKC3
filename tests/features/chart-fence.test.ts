/**
 * chart フェンスの読み取り(#188 / 台帳 #180 の B-1)。
 *
 * 🔴 守る主張:
 * 1. **知っている key だけ通す**(allowlist)── 関数の入る余地を作らない
 * 2. 上限を数で持つ(事故った本文が画面と worker を潰さない)
 * 3. 欠測は `null` のまま(0 で埋めない ── 折れ線が谷になる)
 * 4. 読めないときは**理由を返す**(黙って空にしない)
 * 5. 絵の代わりに読む文がある(画像 1 枚で出す以上、無いと読み上げでは空)
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_TYPES,
  MAX_DATASETS,
  MAX_POINTS,
  MAX_LABEL_CHARS,
  chartAltText,
  parseChartFence,
} from '../../src/features/markdown/chart-fence';

const ok = (o: unknown) => parseChartFence(JSON.stringify(o));

describe('chart フェンスの読み取り', () => {
  it('素直な設定が通る', () => {
    const r = ok({ type: 'bar', labels: ['1月', '2月'], datasets: [{ label: '売上', data: [10, 20] }] });
    expect(r.error).toBeNull();
    expect(r.spec?.type).toBe('bar');
    expect(r.spec?.datasets[0]?.data).toEqual([10, 20]);
  });

  it('🔴 知らない key は落とす(関数の入る余地を作らない)', () => {
    const r = ok({
      type: 'line',
      labels: ['a'],
      datasets: [{ label: 'x', data: [1], borderDash: [5, 5], onClick: 'alert(1)' }],
      options: { plugins: { tooltip: { callbacks: 'x' } } },
      onHover: 'boom',
    });
    expect(r.error).toBeNull();
    const spec = r.spec!;
    expect(Object.keys(spec.datasets[0]!)).toEqual(['label', 'data']);
    expect(JSON.stringify(spec), '知らない設定が生き残っている').not.toContain('callbacks');
    expect(JSON.stringify(spec)).not.toContain('onHover');
  });

  it('🔴 欠測は null のまま(0 で埋めない)', () => {
    const r = ok({ type: 'line', labels: [], datasets: [{ label: 'x', data: [1, null, '', 3] }] });
    expect(r.spec?.datasets[0]?.data).toEqual([1, null, null, 3]);
  });

  it('NaN / Infinity は欠測に倒す(軸が壊れる)', () => {
    const r = parseChartFence('{"type":"line","datasets":[{"label":"x","data":[1,"abc",2]}]}');
    expect(r.spec?.datasets[0]?.data).toEqual([1, null, 2]);
  });

  it('🔴 上限で切る(系列 / 点 / 文字)', () => {
    const many = Array.from({ length: MAX_DATASETS + 5 }, (_, i) => ({
      label: `s${i}`,
      data: [1],
    }));
    expect(ok({ type: 'bar', datasets: many }).spec?.datasets).toHaveLength(MAX_DATASETS);

    const long = Array.from({ length: MAX_POINTS + 100 }, (_, i) => i);
    expect(ok({ type: 'line', datasets: [{ label: 'x', data: long }] }).spec?.datasets[0]?.data).toHaveLength(
      MAX_POINTS,
    );

    const title = 'あ'.repeat(MAX_LABEL_CHARS + 50);
    expect([...(ok({ type: 'bar', title, datasets: [{ label: 'x', data: [1] }] }).spec?.title ?? '')]).toHaveLength(
      MAX_LABEL_CHARS,
    );
  });

  it('🔴 読めないときは理由を返す(黙って空にしない)', () => {
    expect(parseChartFence('').error).toContain('空');
    expect(parseChartFence('{ oops').error).toContain('JSON');
    expect(parseChartFence('[1,2]').error).toContain('{ }');
    expect(ok({ type: 'pyramid', datasets: [{ label: 'x', data: [1] }] }).error).toContain('type');
    expect(ok({ type: 'bar', datasets: [] }).error).toContain('datasets');
    expect(ok({ type: 'bar', datasets: [{ label: 'x', data: [] }] }).error).toContain('data');
  });

  it('描ける形は 1 か所にだけ持つ', () => {
    expect([...CHART_TYPES]).toEqual(['bar', 'line', 'pie', 'doughnut', 'radar', 'scatter']);
    for (const t of CHART_TYPES) {
      expect(ok({ type: t, datasets: [{ label: 'x', data: [1] }] }).error, `${t} が通らない`).toBeNull();
    }
  });

  it('🔴 絵の代わりに読む文が出る(何の図か・何系列か・範囲)', () => {
    const r = ok({
      type: 'bar',
      title: '月別',
      labels: ['1月'],
      datasets: [{ label: '売上', data: [10, 30] }],
    });
    const alt = chartAltText(r.spec!);
    expect(alt).toContain('棒グラフ');
    expect(alt).toContain('売上');
    expect(alt).toContain('10');
    expect(alt).toContain('30');
  });

  it('値が全部欠測でも読む文は壊れない', () => {
    const r = ok({ type: 'line', datasets: [{ label: 'x', data: [null, null] }] });
    expect(() => chartAltText(r.spec!)).not.toThrow();
  });
});
