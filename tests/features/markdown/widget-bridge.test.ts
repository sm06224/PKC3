/** @vitest-environment happy-dom */
/**
 * ウィジェットの純関数の契約(v4.0 Phase 2 / PR-07)。
 *
 * 守る主張:
 * 1. `id=` は見出しの残りから読む(`-render` / `-norender` / `tool` と両立)。読めない id は捨てて**状態を持たない表示**に落とす
 * 2. 保存先の名前空間は衝突しない(`lid` / `id` の `.` で越境しない)
 * 3. テーマは許した変数だけを渡す(値は安全な字だけ)。prelude は `</script>` で途切れない
 * 4. 本文の姿:`id=` の在る ` ```html ` は器(placeholder)、無いものは今までどおり箱。React / jsx は id を器に添える
 * 5. 箱の中の prelude が実際に動く(テーマを受けて `--pkc-*` / `data-pkc-tone` を当て、購読者へ知らせる)
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseWidgetId,
  widgetEntryPrefix,
  widgetFrameId,
  widgetPlaceholderHtml,
  widgetPrelude,
  widgetStoragePrefix,
  widgetThemeFrom,
  widgetThemePreludeScript,
  WIDGET_ID_RE,
  WIDGET_READY_MSG_TYPE,
  WIDGET_STORAGE_LIMIT,
  WIDGET_STORAGE_MESSAGE,
  WIDGET_THEME_MSG_TYPE,
  WIDGET_THEME_TOKENS,
} from '../../../src/features/markdown/widget-bridge';
import { parseRenderableFence, renderMarkdown } from '../../../src/features/markdown/markdown-render';
import { buildHtmlSandboxIframe } from '../../../src/features/markdown/html-sandbox';

describe('id= の読み方', () => {
  it('🔴 引用符あり / なし / 他の語との併用を読む', () => {
    expect(parseWidgetId('id="budget"')).toBe('budget');
    expect(parseWidgetId("id='timer'")).toBe('timer');
    expect(parseWidgetId('id=calc')).toBe('calc');
    expect(parseWidgetId('tool id="calc"')).toBe('calc');
    expect(parseWidgetId('id = "a_b-1"')).toBe('a_b-1');
  });

  it('🔴 -render / -norender / tool を併用しても見出しは同じ言語・形で読まれ、id は残りに入る', () => {
    const r = parseRenderableFence('html-render id="timer"');
    expect(r?.lang).toBe('html');
    expect(r?.mode).toBe('render');
    expect(parseWidgetId(r?.rest)).toBe('timer');
    const n = parseRenderableFence('html-norender id="x"');
    expect(n?.mode).toBe('norender');
    expect(parseWidgetId(parseRenderableFence('html tool id="calc"')?.rest)).toBe('calc');
  });

  it('🔴 読めない id は null(許す字の外・長すぎる・空・先頭が記号)', () => {
    for (const bad of ['id=""', 'id="a b"', 'id="_x"', 'id="-x"', `id="${'a'.repeat(65)}"`, 'id="a.b"', 'id="あ"', 'id="<x>"']) {
      expect(parseWidgetId(bad), bad).toBeNull();
    }
    expect(parseWidgetId('')).toBeNull();
    expect(parseWidgetId(null)).toBeNull();
    expect(parseWidgetId('noid')).toBeNull();
    // `xid=` を id と読まない
    expect(parseWidgetId('xid="a"')).toBeNull();
    // 64 字ちょうどは通る
    expect(parseWidgetId(`id="${'a'.repeat(64)}"`)).toBe('a'.repeat(64));
    expect(WIDGET_ID_RE.test('A9_-')).toBe(true);
  });
});

describe('保存先の名前空間', () => {
  it('🔴 lid="a"+id="b.c" と lid="a.b"+id="c" は別の空間(`.` で越境しない)', () => {
    // ⚠ id には `.` を許していないが、名前空間の関数は id の検証に頼らず越境を防ぐ(二重の門)
    const p1 = widgetStoragePrefix('a', 'b.c');
    const p2 = widgetStoragePrefix('a.b', 'c');
    expect(p1).not.toBe(p2);
    expect(p1.startsWith(p2) || p2.startsWith(p1)).toBe(false);
    expect(p1).toBe('pkc3.widget.a.b%2Ec.');
    expect(p2).toBe('pkc3.widget.a%2Eb.c.');
  });

  it('1 ノートの前置きは、そのノートのウィジェットだけを含む(別の lid の前置きにならない)', () => {
    expect(widgetStoragePrefix('L1', 'w').startsWith(widgetEntryPrefix('L1'))).toBe(true);
    expect(widgetStoragePrefix('L10', 'w').startsWith(widgetEntryPrefix('L1'))).toBe(false);
    expect(widgetStoragePrefix('L1.x', 'w').startsWith(widgetEntryPrefix('L1'))).toBe(false);
  });

  it('ランチャーのアプリの領域(pkc3.app.)とも合図とも分かれている', () => {
    expect(widgetStoragePrefix('a', 'b').startsWith('pkc3.app.')).toBe(false);
    expect(WIDGET_STORAGE_MESSAGE).not.toBe('pkc3.app.storage');
    expect(WIDGET_STORAGE_LIMIT).toBe(512 * 1024);
  });
});

describe('テーマ', () => {
  it('🔴 許した 11 の変数だけを、箱の中の名前(--pkc-*)で渡す', () => {
    const src: Record<string, string> = {
      '--bg': '#111', '--surface': '#222', '--surface-2': '#333', '--fg': '#eee', '--muted': '#999',
      '--accent': 'oklch(70% 0.1 200)', '--border': '#444', '--hairline': 'rgba(0,0,0,.1)', '--radius': '6px',
      '--font': '"Noto Sans JP", sans-serif', '--font-mono': 'ui-monospace',
      '--secret': 'x',
    };
    const t = widgetThemeFrom((n) => src[n] ?? '', 'dark');
    expect(t.tone).toBe('dark');
    expect(Object.keys(t.tokens).sort()).toEqual(WIDGET_THEME_TOKENS.map(([n]) => n).sort());
    expect(t.tokens['--pkc-fg']).toBe('#eee');
    expect(t.tokens['--pkc-font']).toBe('"Noto Sans JP", sans-serif');
    expect(Object.values(t.tokens)).not.toContain('x');
  });

  it('🔴 危ない字を含む値・空の値は渡さない / tone は light か dark だけ', () => {
    const t = widgetThemeFrom(
      (n) => (n === '--fg' ? 'red;} body{x:y' : n === '--bg' ? '</style><script>' : n === '--accent' ? '  ' : '#000'),
      'weird',
    );
    expect(t.tone).toBe('light');
    expect(t.tokens['--pkc-fg']).toBeUndefined();
    expect(t.tokens['--pkc-bg']).toBeUndefined();
    expect(t.tokens['--pkc-accent']).toBeUndefined();
    expect(t.tokens['--pkc-border']).toBe('#000');
  });

  it('🔴 prelude は `</script>` を含む id でも script を途切れさせない', () => {
    const s = widgetThemePreludeScript('x</script><script>alert(1)</script>', 'w');
    // 開きと閉じはそれぞれ 1 つだけ(id の中の `</script>` は逃がされている)
    expect(s.match(/<\/script>/gi)).toHaveLength(1);
    expect(s.match(/<script>/gi)).toHaveLength(1);
    expect(s).toContain(WIDGET_THEME_MSG_TYPE);
    expect(s).toContain(WIDGET_READY_MSG_TYPE);
  });

  it('🔴 保存つきの prelude は「保存の shim → テーマ」の順(テーマが差し替え後の localStorage を掴む)で、seed も逃がす', () => {
    const p = widgetPrelude('fid', 'w', { k: '</script><b>' });
    expect(p.indexOf(WIDGET_STORAGE_MESSAGE)).toBeGreaterThan(-1);
    expect(p.indexOf(WIDGET_STORAGE_MESSAGE)).toBeLessThan(p.indexOf(WIDGET_THEME_MSG_TYPE));
    expect(p.match(/<\/script>/gi)).toHaveLength(2);
    expect(p).toContain(String(WIDGET_STORAGE_LIMIT));
  });
});

describe('本文での姿', () => {
  it('🔴 id= の在る html は器(placeholder)だけ ── 箱も保存の中身も HTML に焼かない', () => {
    const html = renderMarkdown('```html id="counter"\n<button>+</button>\n```\n', { liveWidgets: true });
    expect(html).toContain('pkc-widget-placeholder');
    expect(html).toContain('data-pkc-widget-live="1"');
    expect(html).toContain('data-pkc-widget-id="counter"');
    expect(html).toContain('data-pkc-widget-kind="html"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('srcdoc');
    // 原文は受け皿として字で残る(書き出しで読める)
    expect(html).toContain('pkc-widget-source');
    expect(html).toContain('&lt;button&gt;+&lt;/button&gt;');
  });

  it('🔴 保存つきでない面(既定 = 書き出し・埋め込み・プレビュー)の id= は今までどおりの箱で、箱の中だけの localStorage を持つ', () => {
    const html = renderMarkdown('```html id="counter"\n<button>+</button>\n```\n');
    expect(html).toContain('<iframe');
    expect(html).not.toContain('pkc-widget-placeholder');
    // 1 行目の localStorage で止まらない(shim は入る)が、seed は空
    expect(html).toContain(WIDGET_STORAGE_MESSAGE);
    expect(html).toContain('sandbox="allow-scripts"');
    const r = renderMarkdown('```react id="c"\nexport default function App(){return <b/>}\n```\n');
    expect(r).toContain('data-pkc-widget-id="c"');
    expect(r, '保存つきでない面の React に保存の印が付いた').not.toContain('data-pkc-widget-live');
    const live = renderMarkdown('```react id="c"\nexport default function App(){return <b/>}\n```\n', { liveWidgets: true });
    expect(live).toContain('data-pkc-widget-live="1"');
  });

  it('🔴 id= の無い html / 読めない id は今までどおりの箱(器にしない)', () => {
    for (const info of ['html', 'html id="a b"', 'html-render']) {
      const html = renderMarkdown(`\`\`\`${info}\n<p>x</p>\n\`\`\`\n`);
      expect(html, info).toContain('<iframe');
      expect(html, info).not.toContain('pkc-widget-placeholder');
    }
  });

  it('id= の在る html-render / html-norender も規約どおり(norender は原文だけ)', () => {
    const r = renderMarkdown('```html-render id="t"\n<p>x</p>\n```\n', { liveWidgets: true });
    expect(r).toContain('pkc-widget-placeholder');
    expect(r).toContain('data-pkc-render-mode="render"');
    const n = renderMarkdown('```html-norender id="t"\n<p>x</p>\n```\n', { liveWidgets: true });
    expect(n).not.toContain('pkc-widget-placeholder');
    expect(n).not.toContain('<iframe');
  });

  it('svg は id= を書いても状態を持たない(今までどおりの箱)', () => {
    const html = renderMarkdown('```svg id="s"\n<svg></svg>\n```\n');
    expect(html).toContain('<iframe');
    expect(html).not.toContain('pkc-widget-placeholder');
  });

  it('🔴 react / jsx の id= は React の器に添える。素の jsx は今までどおりコード', () => {
    const r = renderMarkdown('```react id="counter"\nexport default function App(){return <b/>}\n```\n');
    expect(r).toContain('data-pkc-react-src');
    expect(r).toContain('data-pkc-widget-id="counter"');
    const j = renderMarkdown('```jsx id="counter"\nexport default function App(){return <b/>}\n```\n');
    expect(j).toContain('data-pkc-react-src');
    expect(j).toContain('data-pkc-widget-id="counter"');
    const plain = renderMarkdown('```jsx\nexport default function App(){return <b/>}\n```\n');
    expect(plain).not.toContain('data-pkc-react-src');
    const noid = renderMarkdown('```react\nexport default function App(){return <b/>}\n```\n');
    expect(noid).not.toContain('data-pkc-widget-id');
  });

  it('🔴 器の HTML は決定的(状態が変わっても塊が作り直されない)', () => {
    const md = '```html id="c"\n<p>x</p>\n```\n';
    expect(renderMarkdown(md, { liveWidgets: true })).toBe(renderMarkdown(md, { liveWidgets: true }));
    expect(widgetPlaceholderHtml('<p>"x"</p>', 'c', false)).toBe(widgetPlaceholderHtml('<p>"x"</p>', 'c', false));
    expect(widgetFrameId('html', 'c', 'x', 0)).toBe(widgetFrameId('html', 'c', 'x', 0));
    expect(widgetFrameId('html', 'c', 'x', 0)).not.toBe(widgetFrameId('html', 'c', 'x', 1));
  });

  it('🔴 状態を持たない箱にもテーマ連動の prelude が入り、文字色は --pkc-fg(親が無ければ #222)', () => {
    const f = buildHtmlSandboxIframe('<p>x</p>');
    expect(f).toContain('data-pkc-widget-frame');
    expect(f).toContain(WIDGET_READY_MSG_TYPE);
    expect(f).toContain('var(--pkc-fg,#222)');
    // 状態を持たない箱には保存の shim を入れない
    expect(f).not.toContain(WIDGET_STORAGE_MESSAGE);
    expect(f).toContain('sandbox="allow-scripts"');
    expect(f).not.toContain('allow-same-origin');
  });
});

describe('箱の中の prelude が動く', () => {
  const run = (script: string): void => {
    const code = script.replace(/^<script>/, '').replace(/<\/script>$/, '');
    new Function(code)();
  };
  afterEach(() => {
    delete (window as unknown as { pkcWidget?: unknown }).pkcWidget;
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-pkc-tone');
  });

  it('🔴 テーマを受けると --pkc-* / data-pkc-tone / color-scheme を当て、onTheme の購読者へ知らせる(解除できる)', () => {
    run(widgetThemePreludeScript('fid', null));
    const api = (window as unknown as {
      pkcWidget: {
        id: string | null;
        storage: unknown;
        getTheme: () => { tone: string | null; tokens: Record<string, string> };
        onTheme: (cb: (t: unknown) => void) => () => void;
      };
    }).pkcWidget;
    expect(api.id).toBeNull();
    expect(api.storage, '状態を持たない箱に保存を渡した').toBeNull();
    const seen: unknown[] = [];
    const off = api.onTheme((t) => seen.push(t));
    // 親(happy-dom では window.parent === window)から届いたテーマ
    const ev = new MessageEvent('message', {
      data: { type: WIDGET_THEME_MSG_TYPE, tone: 'dark', tokens: { '--pkc-fg': '#eee', '--pkc-bg': 'x;y', '--evil': 'red' } },
    });
    Object.defineProperty(ev, 'source', { value: window.parent, configurable: true });
    window.dispatchEvent(ev);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--pkc-fg')).toBe('#eee');
    expect(root.style.getPropertyValue('--pkc-bg'), '危ない値を当てた').toBe('');
    expect(root.style.getPropertyValue('--evil'), '許していない名前を当てた').toBe('');
    expect(root.getAttribute('data-pkc-tone')).toBe('dark');
    expect(api.getTheme().tone).toBe('dark');
    expect(api.getTheme().tokens['--pkc-fg']).toBe('#eee');
    expect(seen).toHaveLength(1);
    off();
    window.dispatchEvent(ev);
    expect(seen, '解除した購読者へ届いた').toHaveLength(1);
  });

  it('🔴 親以外(source が別)から来たテーマは無視する', () => {
    run(widgetThemePreludeScript('fid', 'w'));
    const ev = new MessageEvent('message', { data: { type: WIDGET_THEME_MSG_TYPE, tone: 'dark', tokens: { '--pkc-fg': '#f00' } } });
    Object.defineProperty(ev, 'source', { value: {}, configurable: true });
    window.dispatchEvent(ev);
    expect(document.documentElement.style.getPropertyValue('--pkc-fg')).toBe('');
    expect(document.documentElement.getAttribute('data-pkc-tone')).toBeNull();
  });
});
