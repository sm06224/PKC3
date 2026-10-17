/** @vitest-environment node */
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

  it('値が一部だけ欠測でも読む文は壊れない', () => {
    const r = ok({ type: 'line', datasets: [{ label: 'x', data: [null, 3] }] });
    expect(() => chartAltText(r.spec!)).not.toThrow();
    expect(chartAltText(r.spec!)).toContain('3');
  });
});

describe('🔴 散布図は {x, y} の点を描く(R1)', () => {
  it('{x,y} の点が points に入る(空のグラフにならない)', () => {
    const r = ok({
      type: 'scatter',
      datasets: [{ label: '身長', data: [{ x: 150, y: 48 }, { x: '165', y: 58 }, { x: 180, y: 75 }] }],
    });
    expect(r.error).toBeNull();
    const d = r.spec!.datasets[0]!;
    expect(d.points).toEqual([
      { x: 150, y: 48 },
      { x: 165, y: 58 },
      { x: 180, y: 75 },
    ]);
    // 読み上げ用の範囲は y の値から出る(絵の代わりの文が空にならない)
    expect(d.data).toEqual([48, 58, 75]);
    expect(chartAltText(r.spec!)).toContain('散布図');
    expect(chartAltText(r.spec!)).toContain('75');
  });

  it('x か y が読めない点は飛ばす / 数だけ書いたら x を 0 から振る', () => {
    const a = ok({
      type: 'scatter',
      datasets: [{ label: 'a', data: [{ x: 1, y: 2 }, { x: 'abc', y: 3 }, { x: 4 }, { y: 5 }, null] }],
    });
    expect(a.spec!.datasets[0]!.points).toEqual([{ x: 1, y: 2 }]);
    const b = ok({ type: 'scatter', datasets: [{ label: 'b', data: [7, null, 9] }] });
    expect(b.spec!.datasets[0]!.points).toEqual([
      { x: 0, y: 7 },
      { x: 2, y: 9 },
    ]);
  });

  it('散布図以外は points を持たない(対照群)', () => {
    const r = ok({ type: 'line', datasets: [{ label: 'x', data: [{ x: 1, y: 2 }] }] });
    // {x,y} は line では数として読めない → 断る(空のグラフを黙って出さない)
    expect(r.spec).toBeNull();
    expect(r.error).toContain('datasets');
    expect(ok({ type: 'bar', datasets: [{ label: 'x', data: [1] }] }).spec!.datasets[0]).not.toHaveProperty('points');
  });

  it('🔴 点が 1 つも読めない散布図は、散布図の書き方を添えて断る', () => {
    const r = ok({ type: 'scatter', datasets: [{ label: 'x', data: [{ a: 1 }, 'z'] }] });
    expect(r.spec).toBeNull();
    expect(r.error).toContain('"x"');
    expect(r.error).toContain('"y"');
  });
});

describe('🔴 取りこぼしは notes で知らせる(R8)', () => {
  it('何も欠けないときは notes が空(対照群)', () => {
    const r = ok({ type: 'bar', datasets: [{ label: 'x', data: [1, 2] }] });
    expect(r.notes).toEqual([]);
  });

  it('系列が上限を超えたら、描かなかった本数を言う', () => {
    const many = Array.from({ length: MAX_DATASETS + 3 }, (_, i) => ({ label: `s${i}`, data: [1] }));
    const r = ok({ type: 'bar', datasets: many });
    expect(r.notes.join('/')).toContain(`${MAX_DATASETS} 本まで`);
    expect(r.notes.join('/')).toContain('3 本は描いていません');
  });

  it('点が上限を超えたら言う(ちょうどなら言わない)', () => {
    const exact = Array.from({ length: MAX_POINTS }, (_, i) => i);
    expect(ok({ type: 'line', datasets: [{ label: 'x', data: exact }] }).notes).toEqual([]);
    const over = Array.from({ length: MAX_POINTS + 1 }, (_, i) => i);
    expect(ok({ type: 'line', datasets: [{ label: 'x', data: over }] }).notes.join('/')).toContain(`${MAX_POINTS}`);
    // 散布図でも同じ
    const pts = Array.from({ length: MAX_POINTS + 1 }, (_, i) => ({ x: i, y: i }));
    expect(ok({ type: 'scatter', datasets: [{ label: 'x', data: pts }] }).notes.join('/')).toContain(`${MAX_POINTS}`);
  });

  it('120 字を超えた題名・凡例・色は切ったと言う(ちょうどなら言わない)', () => {
    const exact = 'あ'.repeat(MAX_LABEL_CHARS);
    expect(ok({ type: 'bar', title: exact, datasets: [{ label: exact, data: [1] }] }).notes).toEqual([]);
    const over = 'あ'.repeat(MAX_LABEL_CHARS + 1);
    for (const o of [
      { title: over, datasets: [{ label: 'x', data: [1] }] },
      { datasets: [{ label: over, data: [1] }] },
      { datasets: [{ label: 'x', data: [1], color: over }] },
      { labels: [over], datasets: [{ label: 'x', data: [1] }] },
    ]) {
      expect(ok({ type: 'bar', ...o }).notes.join('/'), JSON.stringify(Object.keys(o))).toContain(
        `${MAX_LABEL_CHARS} 字まで`,
      );
    }
  });

  it('空・形の違う・数が読めない系列は、何番目かを言って描かない', () => {
    const r = ok({
      type: 'line',
      datasets: [
        { label: 'ok', data: [1] },
        { label: 'empty', data: [] },
        'x',
        { label: 'nan', data: ['abc', null] },
        { label: 'ok2', data: [2] },
      ],
    });
    expect(r.spec!.datasets.map((d) => d.label)).toEqual(['ok', 'ok2']);
    expect(r.notes.join('/')).toContain('2・3・4 番目の系列');
  });

  it('全部描けないときは notes ではなく理由(error)を返す', () => {
    const r = ok({ type: 'line', datasets: [{ label: 'x', data: [null, null] }] });
    expect(r.spec).toBeNull();
    expect(r.error).toContain('数値');
    expect(r.notes).toEqual([]);
  });
});
