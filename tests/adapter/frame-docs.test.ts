/** @vitest-environment happy-dom */
/**
 * 描画用の枠(plotly / React)の中身の作り(#528)。
 *
 * 守る主張(どれも「外へ出ない」方針の部品 ── 外すと壊れることを見る):
 * 1. CSP: `default-src 'none'`、`connect-src` / `frame-src` を開けない、外部の URL を 1 つも含まない
 * 2. CSP の meta が**どの `<script>` よりも前**にある(後ろだと、先に走った script には方針が効かない)
 * 3. plotly の台本は、送り主が親の窓かを見る(`ev.source!==parent`)
 * 4. 同梱ライブラリの字を inline で入れても、`</script` / `<!--` で script が崩れない(実物の字で見る)
 * 5. 違反の申告: ` ```html ` の枠は画像も数える / React の枠は画像を申告しない(押しても効かない同意の帯を出さない)
 * 6. 絵のキャッシュ鍵の `engine` に plotly / pdf.js の版が入り、package.json の版と一致する
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLOTLY_FRAME_CSP,
  PLOTLY_FRAME_HARNESS,
  plotlyFrameDoc,
} from '../../src/adapter/platform/render/plotly-frame-doc';
import { REACT_FRAME_CSP, reactFrameDoc } from '../../src/adapter/platform/render/react-frame-doc';
import { escapeScript } from '../../src/adapter/platform/render/script-escape';
import { sandboxViolationScript } from '../../src/features/markdown/html-sandbox';
import { PDF_ENGINE } from '../../src/adapter/ui/render/pdf-raster';
import { PLOTLY_ENGINE } from '../../src/adapter/ui/render/plotly-raster';
import { PDFJS_VERSION, PLOTLY_VERSION } from '../../src/runtime/lib-versions';

const SCRIPT_OPEN = '<script';

/** CSP の meta の位置と、最初の `<script` の位置。 */
function order(doc: string): { meta: number; script: number } {
  return { meta: doc.indexOf('http-equiv="Content-Security-Policy"'), script: doc.indexOf(SCRIPT_OPEN) };
}

describe('plotly の枠', () => {
  const doc = plotlyFrameDoc('/*PLOTLY*/');

  it('🔴 CSP: default-src none、connect-src / frame-src を開けない、画像は data: と blob: だけ', () => {
    expect(PLOTLY_FRAME_CSP).toContain("default-src 'none'");
    expect(PLOTLY_FRAME_CSP).not.toContain('connect-src');
    expect(PLOTLY_FRAME_CSP).not.toContain('frame-src');
    expect(PLOTLY_FRAME_CSP).toContain('img-src data: blob:');
    expect(PLOTLY_FRAME_CSP).not.toMatch(/https?:|\*/);
    expect(doc).toContain(`content="${PLOTLY_FRAME_CSP}"`);
  });

  it('🔴 外部の URL を 1 つも含まない(外部の script / 画像を読ませない)', () => {
    expect(doc).not.toMatch(/https?:\/\//);
    expect(doc).not.toMatch(/<script[^>]+src=/);
    expect(doc).not.toMatch(/<link\b/);
  });

  it('🔴 CSP の meta が、どの script よりも前にある', () => {
    const o = order(doc);
    expect(o.meta, 'meta が無い').toBeGreaterThan(-1);
    expect(o.script, 'script が無い(この検査は空振り)').toBeGreaterThan(-1);
    expect(o.meta).toBeLessThan(o.script);
    // すべての script について
    let from = 0;
    for (;;) {
      const i = doc.indexOf(SCRIPT_OPEN, from);
      if (i < 0) break;
      expect(i).toBeGreaterThan(o.meta);
      from = i + 1;
    }
  });

  it('🔴 台本は、送り主が親の窓かを見て、違えば何もしない', () => {
    expect(PLOTLY_FRAME_HARNESS).toContain('ev.source!==parent');
    expect(doc).toContain('ev.source!==parent');
    // 見ている位置:依頼を処理する前(toImage より前)
    expect(PLOTLY_FRAME_HARNESS.indexOf('ev.source!==parent')).toBeLessThan(PLOTLY_FRAME_HARNESS.indexOf('Plotly.toImage'));
  });
});

describe('React の枠', () => {
  const doc = reactFrameDoc('export default () => <i/>', '/*R*/', '/*T*/', 'pkc-react-x');

  it('🔴 CSP の meta が、どの script よりも前にある(違反の見張りの script も後ろ)', () => {
    const o = order(doc);
    expect(o.meta).toBeGreaterThan(-1);
    expect(o.script).toBeGreaterThan(-1);
    expect(o.meta).toBeLessThan(o.script);
    expect(doc.indexOf('securitypolicyviolation'), '見張りが CSP より前').toBeGreaterThan(o.meta);
  });

  it('🔴 CSP は default-src none / connect-src none / frame-src none。外部の URL を含まない', () => {
    expect(REACT_FRAME_CSP).toContain("default-src 'none'");
    expect(REACT_FRAME_CSP).toContain("connect-src 'none'");
    expect(REACT_FRAME_CSP).toContain("frame-src 'none'");
    expect(doc).not.toMatch(/https?:\/\//);
  });
});

describe('同梱ライブラリの字を inline で入れる', () => {
  it('🔴 `</script` と `<!--` を逃がす(unit)', () => {
    const out = escapeScript('a="</script>";b="<!--<script>";c=/<!--/u');
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<!--');
    // 意味は変わらない(字の中の逃がし)
    expect(new Function(`return ${out.split(';')[0]!.slice(2)}`)()).toBe('</script>');
    expect(new Function(`return ${out.split(';')[1]!.slice(2)}`)()).toBe('<!--<script>');
    // 正規表現の u フラグでも構文エラーにならない
    expect(() => new Function(`return ${out.split(';')[2]!.slice(2)}`)()).not.toThrow();
    expect(new Function(`return ${out.split(';')[2]!.slice(2)}`)().test('<!--')).toBe(true);
  });

  it('🔴 実物のランタイム(React・Tailwind)と plotly.js の字を入れても、script が崩れない', async () => {
    const runtime = (await import('virtual:pkc3-react-runtime')).default;
    const tailwind = (await import('virtual:pkc3-tailwind')).default;
    const plotly = readFileSync('node_modules/plotly.js-dist-min/plotly.min.js', 'utf8');
    const docs: Array<[string, number]> = [
      [reactFrameDoc('export default () => <i/>', runtime, tailwind, 'i'), 5],
      [plotlyFrameDoc(plotly), 2],
    ];
    for (const [d, scripts] of docs) {
      expect(d, '`<!--` が残っている(その後に <script が来ると script が終わらなくなる)').not.toContain('<!--');
      // script を閉じる字は、本物の script の数だけ(字の中の `</script` で途切れない)。
      // ⚠ 開きの `<script>` はライブラリの字の中にも在りうる(`<!--` が無ければ害は無い)ので、閉じの側を数える
      expect(d.match(/<\/script>/g)?.length ?? 0).toBe(scripts);
    }
  });
});

describe('違反の申告', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 申告の script を動かし、違反を撃って、親へ送られた物を返す。 */
  async function run(script: string, directives: string[]): Promise<Array<{ blocked: number; kinds: string[] }>> {
    vi.restoreAllMocks(); // 同じ test の中で 2 度呼んでも、前の spy を重ねない
    vi.useFakeTimers();
    const sent: Array<{ blocked: number; kinds: string[] }> = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((m: { blocked: number; kinds: string[] }) => {
      sent.push(m);
    }) as typeof window.postMessage);
    const body = script.replace(/^<script>/, '').replace(/<\/script>$/, '');
    // happy-dom の window.parent は自分自身
    // 🔴 前の test が登録した見張りが生きていると、そちらも撃たれる ── 登録を控えて、終わったら外す
    const added: Array<[string, EventListenerOrEventListenerObject]> = [];
    const orig = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(((t: string, f: EventListenerOrEventListenerObject, o?: unknown) => {
      added.push([t, f]);
      orig(t, f, o as AddEventListenerOptions);
    }) as typeof document.addEventListener);
    new Function(body)();
    for (const d of directives) {
      const ev = new Event('securitypolicyviolation');
      Object.defineProperty(ev, 'effectiveDirective', { value: d });
      document.dispatchEvent(ev);
    }
    await vi.advanceTimersByTimeAsync(100);
    for (const [t, f] of added) document.removeEventListener(t, f);
    return sent;
  }

  it('🔴 既定(` ```html ` の枠)は画像の違反を数えて申告する', async () => {
    const sent = await run(sandboxViolationScript('id-a'), ['img-src', 'img-src']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.blocked).toBe(2);
  });

  it('🔴 React の枠は画像の違反を申告しない(押しても効かない同意の帯を出さない)/ 画像以外は申告する', async () => {
    const onlyImg = await run(sandboxViolationScript('id-b', false), ['img-src', 'img-src-elem']);
    expect(onlyImg, '画像の違反を申告している').toEqual([]);
    const withConnect = await run(sandboxViolationScript('id-c', false), ['img-src', 'connect-src']);
    expect(withConnect).toHaveLength(1);
    expect(withConnect[0]!.blocked, '画像を数えている').toBe(0);
    expect(withConnect[0]!.kinds).toEqual(['connect-src']);
  });

  it('React の枠の中身は、画像を数えない版の見張りを使っている', () => {
    const doc = reactFrameDoc('x', 'r', 't', 'i');
    expect(doc).toContain("if(d.indexOf('img-src')===0)return;kinds[d]=1;");
    expect(doc).not.toContain('blocked++');
  });
});

describe('絵のキャッシュ鍵の産出器', () => {
  it('🔴 engine に plotly / pdf.js の版が入り、入れた版(package.json)と一致する', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(PLOTLY_VERSION).not.toBe('unknown');
    expect(PDFJS_VERSION).not.toBe('unknown');
    expect(PLOTLY_VERSION).toBe(pkg.dependencies['plotly.js-dist-min']);
    expect(PDFJS_VERSION).toBe(pkg.dependencies['pdfjs-dist']);
    expect(PLOTLY_ENGINE).toBe(`plotly.js-${pkg.dependencies['plotly.js-dist-min']}`);
    expect(PDF_ENGINE).toBe(`pdf.js-${pkg.dependencies['pdfjs-dist']}`);
  });
});
