/** @vitest-environment happy-dom */
/**
 * 🔴 **ウィジェットを単体の HTML にする純関数**(#2090 ③)。
 *
 * 守る主張:
 * 1. 断片も完全な文書も、1 枚の完全な文書(`lang="ja"`・`data-pkc-tone`・`<meta charset>`・`<title>`)になる
 * 2. 🔴 `seed` の値に `</script>` / `<!--` が入っていても文書が切れない(script の数が増えない・値がそのまま読める)
 * 3. 配色(light / dark)が `:root` に焼かれ、受け付けない名前・値(`;` `}` `<`)は落ちる
 * 4. 🔴 画面の箱と同じ CSP(`connect-src 'none'` ほか)を持ち、外へ出る口を足さない
 * 5. `id=` の無いウィジェットは保存の shim を入れない(`pkcWidget.storage` は null)
 * 6. ファイル名は `safeName` を通る(予約名・制御文字・記号)
 * 7. 添付のファイル名から `id=` に書ける名前を作る(日本語だけなら `widget`)
 */
import { describe, expect, it } from 'vitest';
import {
  buildStandaloneWidgetHtml,
  standaloneShell,
  standaloneWidgetHead,
  STANDALONE_STORAGE_ROOT,
  widgetExportFileName,
  widgetFenceForAsset,
  widgetIdFromFileName,
} from '../../src/features/markdown/widget-export';
import { WIDGET_ID_RE, type WidgetTheme } from '../../src/features/markdown/widget-bridge';
import { safeName } from '../../src/features/export/file-name';
import { takeFenceAsset } from '../../src/features/markdown/fence-asset';

const LIGHT: WidgetTheme = { tone: 'light', tokens: { '--pkc-bg': '#fafafa', '--pkc-fg': '#111111' } };
const DARK: WidgetTheme = { tone: 'dark', tokens: { '--pkc-bg': '#121212', '--pkc-fg': '#eeeeee' } };

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');
const scriptsOf = (html: string): HTMLScriptElement[] => [...parse(html).querySelectorAll('script')];

describe('単体の HTML の外形', () => {
  it('HTML の断片 → 完全な文書(lang / tone / charset / title / 中身)', () => {
    const html = buildStandaloneWidgetHtml({
      content: '<div id="app">こんにちは</div><script>document.getElementById("app").dataset.ok="1"</script>',
      title: '家計 <簿>',
      widgetId: 'budget',
      seed: {},
      theme: LIGHT,
    });
    expect(html.startsWith('<!DOCTYPE html><html lang="ja" data-pkc-tone="light"><head><meta charset="utf-8"><title>')).toBe(true);
    const d = parse(html);
    expect(d.documentElement.getAttribute('lang')).toBe('ja');
    expect(d.title).toBe('家計 <簿>');
    // ⚠ 題名は escape される(`<簿>` が要素にならない)
    expect(html).toContain('<title>家計 &lt;簿&gt;</title>');
    expect(d.querySelector('#app')?.textContent).toBe('こんにちは');
  });

  it('完全な文書(<!DOCTYPE html>〜)でも壊れず、中身の head の要素と body が残る', () => {
    const content =
      '<!DOCTYPE html><html><head><title>元の題</title><style>.x{color:red}</style></head>' +
      '<body class="tool"><p class="x">本体</p><script>window.__ran=1</script></body></html>';
    const html = buildStandaloneWidgetHtml({ content, title: 'tool', widgetId: null, seed: {}, theme: DARK });
    const d = parse(html);
    // 🔑 外形は 1 つ(二重の <html> にならない)
    expect(d.querySelectorAll('html')).toHaveLength(1);
    expect(d.documentElement.getAttribute('data-pkc-tone')).toBe('dark');
    expect(d.querySelector('p.x')?.textContent).toBe('本体');
    // 🔑 書き出しの題名が先(document.title)
    expect(d.title).toBe('tool');
    // 中身の script と style は残る
    expect(scriptsOf(html).some((s) => s.textContent === 'window.__ran=1')).toBe(true);
    expect(d.body.classList.contains('tool')).toBe(true);
  });

  it('🔴 画面の箱と同じ CSP を持つ(外へ出る口を足さない)', () => {
    const html = buildStandaloneWidgetHtml({ content: '<p>x</p>', title: 't', widgetId: 'a', seed: {}, theme: LIGHT });
    const csp = parse(html).querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    // ⚠ 外部画像は既定で塞ぐ側
    expect(csp).toContain('img-src data: blob:;');
    const opened = buildStandaloneWidgetHtml({
      content: '<p>x</p>',
      title: 't',
      widgetId: 'a',
      seed: {},
      theme: LIGHT,
      allowExternalImages: true,
    });
    const csp2 = parse(opened).querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    expect(csp2).toContain('img-src * data: blob:;');
    expect(csp2).toContain("connect-src 'none'");
  });
});

describe('🔴 seed の埋め込み(文書を切らせない)', () => {
  it('`</script>` / `<!--` / 改行を含む値でも script の数が増えず、値がそのまま読める', () => {
    const evil = '</script><script>alert(1)</script><!-- x';
    const base = buildStandaloneWidgetHtml({ content: '<p>x</p>', title: 't', widgetId: 'w', seed: {}, theme: LIGHT });
    const html = buildStandaloneWidgetHtml({
      content: '<p>x</p>',
      title: 't',
      widgetId: 'w',
      seed: { count: '3', [evil]: evil, 'a\nb': '行1\n行2' },
      theme: LIGHT,
    });
    // ⚠ 値を変えても script の数は変わらない(値が script を閉じていない)
    expect(scriptsOf(html)).toHaveLength(scriptsOf(base).length);
    expect(html).not.toContain('<script>alert(1)');
    // 🔑 値は JS の字面として元どおり(`<` で逃がしている)── 字面を JSON として読み戻す
    const boot = scriptsOf(html).find((s) => s.textContent?.includes(STANDALONE_STORAGE_ROOT))!.textContent!;
    const m = /\}\)\((\{.*?\}),"pkc3-widget-export\./.exec(boot);
    expect(m, 'seed の字面が見つからない').not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual({ count: '3', [evil]: evil, 'a\nb': '行1\n行2' });
  });

  it('保存の名前空間は id ごとに分かれ、`.` も符号化される', () => {
    const head = standaloneWidgetHead({ widgetId: 'a-b', seed: {}, theme: LIGHT });
    expect(head).toContain(`"${STANDALONE_STORAGE_ROOT}a-b."`);
    // 状態を持たない箱は保存の shim を入れない
    const none = standaloneWidgetHead({ widgetId: null, seed: { k: 'v' }, theme: LIGHT });
    expect(none).not.toContain(STANDALONE_STORAGE_ROOT);
    expect(none).not.toContain('"k":"v"');
    // ⚠ 読めない id は状態を持たない側へ落とす(本文を壊さない)
    const bad = standaloneWidgetHead({ widgetId: '../x', seed: { k: 'v' }, theme: LIGHT });
    expect(bad).not.toContain(STANDALONE_STORAGE_ROOT);
  });
});

describe('配色の焼き込み', () => {
  it('light / dark の値が :root と html に入り、受け付けない名前・値は落ちる', () => {
    const dark = standaloneWidgetHead({ widgetId: null, seed: {}, theme: DARK });
    const root = /<style>:root\{([^}]*)\}/.exec(dark)![1]!;
    expect(root).toContain('--pkc-bg:#121212;');
    expect(root).toContain('--pkc-fg:#eeeeee;');
    expect(root).toContain('color-scheme:dark;');
    expect(dark).toContain('html{background:var(--pkc-bg,#fff);color:var(--pkc-fg,#222);}');
    const light = standaloneWidgetHead({ widgetId: null, seed: {}, theme: LIGHT });
    expect(/<style>:root\{([^}]*)\}/.exec(light)![1]).toContain('color-scheme:light;');
    const evil = standaloneWidgetHead({
      widgetId: null,
      seed: {},
      theme: {
        tone: 'dark',
        tokens: { '--pkc-bg': 'red;}</style><script>x()</script>', '--evil': 'blue', '--pkc-fg': '#fff' },
      },
    });
    expect(evil).not.toContain('</style><script>x()');
    expect(evil).not.toContain('--evil');
    expect(evil).toContain('--pkc-fg:#fff;');
  });

  it('親の居ない所でもテーマの合図を自分へ送る(getTheme / onTheme が書き出し時点の配色を返す)', () => {
    const head = standaloneWidgetHead({ widgetId: null, seed: {}, theme: DARK });
    expect(head).toContain('{type:"pkc-widget-theme",tone:"dark",tokens:{"--pkc-bg":"#121212","--pkc-fg":"#eeeeee"}}');
    // 🔑 ノートの参照は親が居なければ待たずに空(3 秒止めない)
    expect(head).toContain('if(window.parent===window)return Promise.resolve(empty());');
  });

  it('standaloneShell は組み手の作った文書だけを外形にする(他はそのまま)', () => {
    expect(standaloneShell('<p>x</p>', 't', 'light')).toBe('<p>x</p>');
    const out = standaloneShell('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', ' ', 'dark');
    expect(out).toContain('<title>ウィジェット</title>');
    expect(out).toContain('data-pkc-tone="dark"');
  });
});

describe('ファイル名と記法', () => {
  it('widgetExportFileName は safeName を通る(予約名・制御文字・記号)', () => {
    expect(widgetExportFileName({ widgetId: 'budget' })).toBe('budget.html');
    expect(widgetExportFileName({ widgetId: null, noteTitle: 'CON' })).toBe(`${safeName('CON')}.html`);
    expect(widgetExportFileName({ widgetId: null, noteTitle: 'CON' })).toBe('CON-file.html');
    expect(widgetExportFileName({ widgetId: null, noteTitle: 'a/b:c*\u0001d' })).toBe('a-b-c--d.html');
    // 添付の名前は拡張子を外して使う(`.html.html` にしない)
    expect(widgetExportFileName({ assetName: 'tool.HTML' })).toBe('tool.html');
    // 優先順: id → 添付名 → 題名 → widget
    expect(widgetExportFileName({ widgetId: 'x', assetName: 'y.html', noteTitle: 'z' })).toBe('x.html');
    expect(widgetExportFileName({ assetName: 'y.html', noteTitle: 'z' })).toBe('y.html');
    expect(widgetExportFileName({ noteTitle: '  ' })).toBe('widget.html');
  });

  it('widgetIdFromFileName は WIDGET_ID_RE に合う名前を作る', () => {
    expect(widgetIdFromFileName('My Tool v2.html')).toBe('My-Tool-v2');
    expect(widgetIdFromFileName('家計簿.html')).toBe('widget');
    expect(widgetIdFromFileName('__x__.htm')).toBe('x');
    const long = widgetIdFromFileName(`${'a'.repeat(100)}.html`);
    expect(long).toHaveLength(64);
    for (const n of ['My Tool v2.html', '家計簿.html', '-a.html', 'a'.repeat(100), '計算 tool.html'])
      expect(WIDGET_ID_RE.test(widgetIdFromFileName(n)), n).toBe(true);
  });

  it('widgetFenceForAsset の囲みは asset と id の両方で読める', () => {
    const fence = widgetFenceForAsset('ast-abc', 'calc.html');
    expect(fence).toBe('```html asset:ast-abc id="calc"\n```');
    const info = fence.split('\n')[0]!.slice(3);
    const parsed = takeFenceAsset(info.split(' ').slice(1).join(' '));
    expect(parsed).toEqual({ kind: 'one', key: 'ast-abc', rest: 'id="calc"' });
  });
});
