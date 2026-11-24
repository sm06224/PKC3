/**
 * 🔴 **600 コマ計測 ── ネオン(輪郭の近接発光)の対照群を取る**(Stage 2 PR-1。製品の挙動は変えない)。
 *
 * 「コマ落ちが 1 以下」を後の PR(ネオンを全ブロックへ広げる)の合格線にするため、**いまの実装の数字**を先に取る。
 * 1440×900 / DPR 2 で、実マウス(`page.mouse.move`)を 600 コマぶん動かす(1 コマ = 1 回の移動 + 次の rAF を待つ)。
 * 道筋は ①カードログ(3 日・数枚のカード)②コード・表・図入りのノート ── 各シーンで 左のバー → 中央の本文 → 情報ペイン を往復する。
 *
 * | 取る物 | 道具 |
 * |---|---|
 * | 長い描画(50ms 超)の件数と合計 | `PerformanceObserver`(`long-animation-frame`。無ければ `longtask`) |
 * | コマ落ち | ページ内の rAF 間隔。**中央値の 2 倍以上**の間隔を 1 つと数える |
 * | 再計算・レイアウト・スクリプトの時間 | CDP `Performance.getMetrics` の前後差(`RecalcStyleDuration` / `LayoutDuration` / `ScriptDuration`) |
 *
 * 🔑 **対照群 = 測りたい操作(発光)だけを外したもの**(perf-measurement の作法)。同じ起動・同じ道筋で、発光だけを外した群と通常を**交互に 2 回ずつ**測る(温め 1 回は捨てる)。
 * ⚠ **`prefers-reduced-motion: reduce` は対照群に使わない** ── 発光のほか、すべての transition / animation / smooth scroll も止めるので「発光だけの差」にならない。
 *   代わりに init script で `matchMedia` を包み、**`GLOW_QUERY`(`neon-glow.ts` の正本をそのまま import)だけ** `matches: false` を返して `change` を送る。
 *   ほかの media query は触らず、`reducedMotion` は両群とも `no-preference` のまま。
 * ⚠ **機械の数字を assert にしない**。assert は ①対照群で光っていない・通常で実際に光った(光ったコマが全コマの 10% 以上 = 空振りでない)
 *   ②コマが十分に取れた ③通常のコマ落ちが対照群より大きく悪くない(許容は広く取る)だけ。コマ落ちは**中央値の 1.5 倍以上**の間隔を 1 つと数える。
 *   数字は console と `PKC3_PERF_OUT`(JSON。形は `SCHEMA` で固定し、spec が形を検査する)へ出す。
 * ⚠ 差し引きの値は**向きだけ**信じる(倍率は書かない)。
 *
 * `PKC3_SKIP_PERF=1` で飛ばせる(負荷の高い手元・CI の共有機で揺れるとき)。
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { GLOW_QUERY } from '../../src/adapter/ui/render/neon-glow';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';

test.use({ deviceScaleFactor: 2 });
test.skip(process.env.PKC3_SKIP_PERF === '1', 'PKC3_SKIP_PERF=1');

/** 🔴 発光だけを外す: `GLOW_QUERY` の問いにだけ `matches: false` を返し(`change` も送る)、ほかの media query は本物のまま。 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((q: string) => {
    const real = window.matchMedia.bind(window);
    const w = window as unknown as { __pkcGlowOff?: (off: boolean) => void };
    let off = false;
    const fns = new Set<(e: Event) => void>();
    const fake = {
      media: q,
      onchange: null,
      get matches(): boolean {
        return !off && real(q).matches;
      },
      addEventListener: (_t: string, f: (e: Event) => void): void => void fns.add(f),
      removeEventListener: (_t: string, f: (e: Event) => void): void => void fns.delete(f),
      addListener: (f: (e: Event) => void): void => void fns.add(f),
      removeListener: (f: (e: Event) => void): void => void fns.delete(f),
      dispatchEvent: (): boolean => true,
    };
    w.__pkcGlowOff = (v: boolean): void => {
      off = v;
      for (const f of fns) f(new Event('change'));
    };
    window.matchMedia = ((query: string): MediaQueryList => (query === q ? (fake as unknown as MediaQueryList) : real(query))) as typeof window.matchMedia;
  }, GLOW_QUERY);
});

/** 出力 JSON の形(単位つき)。変えるときは `schema` の版を上げる。 */
const SCHEMA = {
  schema: 'pkc3-neon-perf/1',
  runFields: {
    label: 'string',
    frames: 'count(rAF 間隔の数)',
    medianMs: 'ms(rAF 間隔の中央値)',
    dropped: 'count(中央値の 1.5 倍以上の間隔)',
    glowFrames: 'count(発光の印が付いていたコマ)',
    loafCount: 'count',
    loafTotalMs: 'ms(長い描画の duration 合計)',
    loafKind: 'long-animation-frame | longtask | none',
    recalcStyleMs: 'ms(CDP RecalcStyleDuration の前後差)',
    layoutMs: 'ms(CDP LayoutDuration の前後差)',
    scriptMs: 'ms(CDP ScriptDuration の前後差)',
  },
} as const;

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const FRAMES_PER_SCENE = 300; // 2 シーン × 300 = 600 コマ

const LOG = Array.from({ length: 12 }, (_, i) => [
  `## 2026-10-${String(1 + Math.floor(i / 4)).padStart(2, '0')} ${String(8 + (i % 4) * 2).padStart(2, '0')}:00:00`,
  `記録${i + 1}の本文です。作業の経過をここに書きます。`,
]).flat().join('\n\n');

const NOTE = [
  '# 計測用のノート',
  '段落です。'.repeat(8),
  '| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| あ | い | う |\n| え | お | か |',
  '```ts\nconst answer = 42;\nfunction f(x: number): number {\n  return x * answer;\n}\n```',
  '```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```',
  '> 引用の段落です。',
].join('\n\n');

async function commitNew(page: Page, archetype: string, title: string, body: string): Promise<void> {
  await createEntry(page, archetype);
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

async function selectByTitle(page: Page, title: string): Promise<void> {
  await clickReal(page, page.locator('[data-pkc-region="sidebar"]').getByText(title, { exact: true }).first());
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText(title === '計測用のログ' ? '記録1の本文' : '計測用のノート');
}

/** 左のバー → 中央の本文 → 情報ペイン → 中央を斜めに、を n 点で結ぶ道筋(CSS px)。 */
async function route(page: Page, n: number): Promise<{ x: number; y: number }[]> {
  const pts = await page.evaluate(() => {
    const c = (sel: string): { x: number; y: number; w: number; h: number } | null => {
      const e = document.querySelector(sel);
      if (e === null) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    return { rail: c('[data-pkc-region="rail"]'), body: c('[data-pkc-region="detail"] [data-pkc-field="detail-body"]'), insp: c('[data-pkc-region="inspector"]') };
  });
  const mid = (r: { x: number; y: number; w: number; h: number } | null, fx: number, fy: number): { x: number; y: number } => ({
    x: (r?.x ?? 100) + (r?.w ?? 100) * fx,
    y: (r?.y ?? 100) + (r?.h ?? 100) * fy,
  });
  const way = [mid(pts.rail, 0.5, 0.15), mid(pts.rail, 0.5, 0.5), mid(pts.body, 0.15, 0.1), mid(pts.body, 0.8, 0.45), mid(pts.body, 0.2, 0.8), mid(pts.insp, 0.5, 0.2), mid(pts.insp, 0.5, 0.7), mid(pts.body, 0.5, 0.3)];
  const out: { x: number; y: number }[] = [];
  const seg = way.length - 1;
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1)) * seg;
    const k = Math.min(seg - 1, Math.floor(t));
    const f = t - k;
    out.push({ x: way[k]!.x + (way[k + 1]!.x - way[k]!.x) * f, y: way[k]!.y + (way[k + 1]!.y - way[k]!.y) * f });
  }
  return out;
}

interface Run {
  label: string;
  frames: number;
  medianMs: number;
  dropped: number;
  glowFrames: number;
  loafCount: number;
  loafTotalMs: number;
  loafKind: string;
  recalcStyleMs: number;
  layoutMs: number;
  scriptMs: number;
}

async function measure(page: Page, label: string, scenes: string[]): Promise<Run> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async (): Promise<Record<string, number>> =>
    Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { ts: number[]; glow: number; long: number[]; kind: string; stop: boolean; po: PerformanceObserver | null } };
    const st = { ts: [] as number[], glow: 0, long: [] as number[], kind: 'none', stop: false, po: null as PerformanceObserver | null };
    w.__perf = st;
    for (const kind of ['long-animation-frame', 'longtask']) {
      if (!PerformanceObserver.supportedEntryTypes.includes(kind)) continue;
      st.kind = kind;
      st.po = new PerformanceObserver((l) => l.getEntries().forEach((e) => st.long.push(e.duration)));
      st.po.observe({ type: kind, buffered: false });
      break;
    }
    const tick = (t: number): void => {
      if (st.stop) return;
      st.ts.push(t);
      if (document.querySelector('[data-pkc-glow-near]') !== null) st.glow += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 群を切り替えた直後の再計算(change → 発光の付け外し)を測りに入れない: 2 コマ待ってから基準を取る
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const m0 = await metrics();
  for (const title of scenes) {
    await selectByTitle(page, title);
    await page.mouse.move(150, 450);
    const path = await route(page, FRAMES_PER_SCENE);
    for (const p of path) {
      await page.mouse.move(p.x, p.y);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    }
  }
  const m1 = await metrics();
  const r = await page.evaluate(() => {
    const st = (window as unknown as { __perf: { ts: number[]; glow: number; long: number[]; kind: string; stop: boolean; po: PerformanceObserver | null } }).__perf;
    st.stop = true;
    st.po?.disconnect();
    const iv = st.ts.slice(1).map((t, i) => t - st.ts[i]!);
    const sorted = [...iv].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return { frames: iv.length, median, dropped: iv.filter((d) => d >= median * 1.5).length, glow: st.glow, long: st.long, kind: st.kind };
  });
  await cdp.detach();
  const d = (k: string): number => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
  return {
    label,
    frames: r.frames,
    medianMs: Math.round(r.median * 100) / 100,
    dropped: r.dropped,
    glowFrames: r.glow,
    loafCount: r.long.length,
    loafTotalMs: Math.round(r.long.reduce((a, b) => a + b, 0)),
    loafKind: r.kind,
    recalcStyleMs: Math.round(d('RecalcStyleDuration')),
    layoutMs: Math.round(d('LayoutDuration')),
    scriptMs: Math.round(d('ScriptDuration')),
  };
}

test('🔴 ネオンの 600 コマ計測: 対照群(発光だけを外す)と通常を同じ道筋で測り、数字を出す (Stage 2 PR-1 @perf)', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await commitNew(page, 'text', '計測用のノート', NOTE);
  await expect(page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]')).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30_000 });
  await commitNew(page, 'textlog', '計測用のログ', LOG);
  await expect(page.locator('[data-pkc-field="detail-body"] > [data-pkc-log-card]').first()).toBeAttached();
  const scenes = ['計測用のログ', '計測用のノート'];

  const runs: Run[] = [];
  const order: [string, boolean][] = [
    ['温め(捨てる)', false],
    ['control-1', true],
    ['glow-1', false],
    ['control-2', true],
    ['glow-2', false],
  ];
  for (const [label, glowOff] of order) {
    await page.evaluate((v) => (window as unknown as { __pkcGlowOff: (o: boolean) => void }).__pkcGlowOff(v), glowOff);
    await page.mouse.move(150, 450);
    const run = await measure(page, label, scenes);
    if (label !== '温め(捨てる)') runs.push(run);
  }

  console.log(`[neon-perf]\n${JSON.stringify(runs, null, 1)}`);
  const report = { schema: SCHEMA.schema, at: new Date().toISOString(), viewport: '1440x900@2', units: SCHEMA.runFields, runs };
  const out = process.env.PKC3_PERF_OUT;
  if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify(report, null, 2));
  // 🔑 出力の形を毎回検査する(書かない実行でも)── JSON を読む側(後の PR・比較の道具)が黙って壊れない
  const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
  expect(parsed.schema).toBe('pkc3-neon-perf/1');
  expect(parsed.runs.length).toBe(4);
  for (const r of parsed.runs) {
    expect(Object.keys(r).sort(), '出力の run の欄が SCHEMA と違う').toEqual(Object.keys(SCHEMA.runFields).sort());
    for (const [k, v] of Object.entries(r)) expect(typeof v, `${k} の型`).toBe(k === 'label' || k === 'loafKind' ? 'string' : 'number');
  }
  // 🔑 GLOW_QUERY が正本の字面と一致している(import が差し替えられても、字面の写しが漂わない)
  expect(readFileSync('src/adapter/ui/render/neon-glow.ts', 'utf-8')).toContain(`export const GLOW_QUERY = '${GLOW_QUERY}'`);

  const control = runs.filter((r) => r.label.startsWith('control'));
  const glow = runs.filter((r) => r.label.startsWith('glow'));
  for (const r of runs) expect(r.frames, `${r.label}: コマが取れていない`).toBeGreaterThan(300);
  for (const r of control) expect(r.glowFrames, `${r.label}: 対照群で光っている(空振り)`).toBe(0);
  for (const r of glow) expect(r.glowFrames, `${r.label}: 通常で光ったコマが全体の 10% に満たない(空振り)`).toBeGreaterThanOrEqual(r.frames * 0.1);
  // 緩い上限: 通常のコマ落ちは対照群の最大 + 5% を超えない(機械の揺れを許す。厳しい線は後の PR が数字を見て決める)
  const worstControl = Math.max(...control.map((r) => r.dropped));
  for (const r of glow) expect(r.dropped, `${r.label}: コマ落ちが対照群(${worstControl})より大きく増えた`).toBeLessThanOrEqual(worstControl + 30);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
