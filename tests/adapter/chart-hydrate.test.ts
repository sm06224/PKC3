/** @vitest-environment happy-dom */
/**
 * chart の器を PNG で埋める(#188 / 台帳 #180 の B-1)。
 *
 * 🔴 守る主張:
 * 1. fence が **placeholder** になる(features 層は DOM を持たない)
 * 2. 埋めるのは **`<img>` 1 枚**(不可侵指示「描いたら焼く」)── SVG を DOM に置かない
 * 3. 焼くのは **ワーカー**(主スレッドで chart.js を動かさない)
 * 4. **貯める所は mermaid と同じ 1 つ**(cache を 2 つ作らない)
 * 5. 読めない本文では**理由が出て原文が残る**(黙って空の枠にしない)
 * 6. 読み上げ用の文が入る(絵しか無い面で唯一の情報)
 * 7. **保存(SVG)の導線を出さない**(chart.js はベクタを吐かない = 押せない導線)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { RENDERABLE_FENCE_LANGS } from '../../src/features/markdown/markdown-render';

const CHART = `\`\`\`chart
{"type":"bar","labels":["1月"],"datasets":[{"label":"売上","data":[10,20]}]}
\`\`\`
`;

describe('chart フェンスの描画(features 層)', () => {
  it('🔴 描ける fence の一覧に居る', () => {
    expect(RENDERABLE_FENCE_LANGS.has('chart')).toBe(true);
  });

  it('🔴 placeholder になり、原文が属性に残る', () => {
    const html = renderMarkdown(CHART);
    expect(html).toContain('pkc-chart-placeholder');
    expect(html).toContain('data-pkc-chart-src');
    // ⚠ 原文は器に残す ── 焼けなかったときに user が何も失わないため
    expect(html).toContain('pkc-chart-source');
  });

  it('🔴 SVG を本文へ埋め込まない(描くのは adapter、置くのは img)', () => {
    const html = renderMarkdown(CHART);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<canvas');
  });

  it('-norender ではソースだけになる(記法の規約はそのまま)', () => {
    const html = renderMarkdown(CHART.replace('```chart', '```chart-norender'));
    expect(html).not.toContain('pkc-chart-placeholder');
    expect(html).toContain('language-chart');
  });
});

describe('chart の器を埋める(adapter 層)', () => {
  let scope: { dispose(): void; prune(): number } | null = null;
  const urls: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    urls.length = 0;
    revoked.length = 0;
    // ⚠ グローバルを丸ごと差し替えない(コンストラクタを壊さない)── 静的メソッドだけ
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:chart-${urls.length}`;
      urls.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
    // happy-dom には IntersectionObserver が無い ── 「すぐ見えた」ことにする
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly cb: (e: unknown[]) => void) {}
        observe(el: Element): void {
          this.cb([{ isIntersecting: true, target: el }]);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    scope?.dispose();
    scope = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** 偽のワーカー ── 「主スレッドで chart.js を動かさない」ことの観測点でもある。 */
  function fakeWorker(onJob: (payload: unknown) => void) {
    class FakeWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      postMessage(msg: { id: number }): void {
        onJob(msg);
        const png = new Uint8Array([1, 2, 3]).buffer;
        queueMicrotask(() =>
          this.onmessage?.({
            data: { id: msg.id, ok: true, result: { png, cssWidth: 320 } },
          } as MessageEvent),
        );
      }
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    return () => new FakeWorker() as unknown as Worker;
  }

  async function mount(source: string) {
    const { hydrateChart } = await import('../../src/adapter/ui/render/chart-raster');
    const { setChartWorkerSpawn } = await import('../../src/adapter/ui/render/chart-raster');
    const jobs: unknown[] = [];
    setChartWorkerSpawn(fakeWorker((j) => jobs.push(j)));
    const host = document.createElement('div');
    host.className = 'pkc-chart-placeholder';
    host.setAttribute('data-pkc-chart-src', source);
    const pre = document.createElement('pre');
    pre.className = 'pkc-chart-source';
    pre.textContent = source;
    host.append(pre);
    document.body.append(host);
    scope = hydrateChart([host]);
    // 焼き終わるまで待つ(microtask + IDB の失敗経路を含めて数 tick)
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
    return { host, jobs };
  }

  it('🔴 img 1 枚で埋まり、ワーカーへ 1 件だけ投げる', async () => {
    const { host, jobs } = await mount(
      '{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1,2]}]}',
    );
    const img = host.querySelector('img');
    expect(img, 'img が入っていない').not.toBeNull();
    expect(img!.getAttribute('data-pkc-field')).toBe('chart-image');
    expect(host.querySelector('canvas'), 'canvas を画面に置いている').toBeNull();
    expect(host.querySelector('svg'), 'SVG を画面に置いている').toBeNull();
    expect(jobs.length, 'ワーカーへ投げていない(主スレッドで描いている)').toBe(1);
  });

  it('🔴 読み上げ用の文が入る(絵しか無い面で唯一の情報)', async () => {
    const { host } = await mount(
      '{"type":"line","title":"月別","labels":["a"],"datasets":[{"label":"売上","data":[1,5]}]}',
    );
    const alt = host.querySelector('img')?.alt ?? '';
    expect(alt).toContain('折れ線');
    expect(alt).toContain('売上');
  });

  it('🔴 保存(SVG)の導線を出さない(押せない導線を置かない)', async () => {
    const { host } = await mount('{"type":"bar","datasets":[{"label":"x","data":[1]}]}');
    expect(host.querySelector('[data-pkc-action="export-diagram"]')).toBeNull();
  });

  it('🔴 読めない本文では理由が出て、原文が残る', async () => {
    const { host, jobs } = await mount('{ これは JSON ではない');
    expect(host.getAttribute('data-pkc-chart-state')).toBe('failed');
    expect(host.getAttribute('data-pkc-chart-error') ?? '').toContain('JSON');
    expect(host.querySelector('.pkc-chart-source'), '原文まで消した').not.toBeNull();
    expect(jobs.length, '読めないのにワーカーを起こした').toBe(0);
  });

  it('🔴 畳むと貸した URL を返す(生成物を残さない)', async () => {
    const { host } = await mount('{"type":"bar","datasets":[{"label":"x","data":[1]}]}');
    expect(urls.length).toBe(1);
    scope?.dispose();
    scope = null;
    expect(revoked, '表示の寿命終端で revoke していない').toEqual(urls);
    void host;
  });
});

/**
 * レビュー(サブエージェント)が名指しした 3 件の穴 ── **直したことを pin する**。
 * ⚠ どれも「本文の面では動くので気づけない」型である。
 */
describe('レビューで見つかった穴', () => {
  it('🔴 貯める鍵に**種類**が入る(同じ原文で古い絵を返さない)', async () => {
    const { cacheKey } = await import('../../src/adapter/ui/render/mermaid-raster');
    const base = {
      source: 'same',
      theme: 'light',
      palette: {
        bg: '#fff', alt: '#eee', fg: '#000', line: '#888',
        border: '#ccc', accent: '#06c', dark: false,
      },
      width: 320,
      dpr: 1,
    };
    expect(cacheKey({ ...base, kind: 'chart' })).not.toBe(cacheKey({ ...base, kind: 'mermaid' }));
    // ⚠ 既定は mermaid(既存の鍵と互換 ── 焼き直しを全部起こさない)
    expect(cacheKey(base)).toBe(cacheKey({ ...base, kind: 'mermaid' }));
  });

  it('🔴 系列の数だけ色がある(6 本目で一巡しない)', async () => {
    const { seriesColors } = await import('../../src/adapter/ui/render/chart-raster');
    const { MAX_DATASETS } = await import('../../src/features/markdown/chart-fence');
    const colors = seriesColors({
      bg: '#fff', alt: '#eee', fg: '#111', line: '#888',
      border: '#ccc', accent: '#0066cc', dark: false,
    });
    expect(colors.length, '系列の上限より色が少ない').toBeGreaterThanOrEqual(MAX_DATASETS);
    expect(new Set(colors).size, '同じ色が混ざっている').toBe(colors.length);
  });

  it('🔴 書き出し HTML でグラフが原文に戻る(空の器で出荷しない)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/features/export/pkc3-html.ts', 'utf-8'),
    );
    // ⚠ 「mermaid だけ書いてある」を落とす ── 両方が同じ経路に載っていること
    expect(src, 'chart を原文へ戻す経路が無い').toContain('data-pkc-chart-src');
    const at = src.indexOf('data-pkc-chart-src');
    const near = src.slice(Math.max(0, at - 400), at + 400);
    expect(near, '図と同じ経路に載っていない').toContain('data-pkc-mermaid-src');
  });
});
