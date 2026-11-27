/**
 * 添付 HTML ウィジェットの追加権限 ── CSP の組み立ての正本(#2090 ②)。
 *
 * 🔴 守る主張:
 * 1. 既定(全部オフ)の CSP は、この PR の前の CSP と **1 文字も違わない**(旧実装の字をここに固定して突き合わせる)
 * 2. どの権限を許しても `frame-src 'none'` / `object-src 'none'` / `base-uri 'none'` を保ち、`'unsafe-eval'` を開けない
 * 3. 権限は独立 ── 外部スクリプトは connect を開けず、通信は script を開けない
 * 4. 直書きの ` ```html ` の箱(`buildHtmlSandboxIframe`)は権限を受け取る口を持たない(常に厳格)
 */
import { describe, expect, it } from 'vitest';
import {
  blockedWidgetPermissions,
  buildSandboxCsp,
  DEFAULT_WIDGET_PERMISSIONS,
  grantedWidgetPermissions,
  WIDGET_PERMISSION_LABELS,
  WIDGET_PERMISSIONS,
  widgetPermissionNoticeText,
} from '../../src/features/markdown/widget-permissions';
import { buildHtmlSandboxDoc, buildHtmlSandboxIframe } from '../../src/features/markdown/html-sandbox';
import { BANNED_TERMS } from '../../src/features/ui-terms';

/** この PR の前の `buildHtmlSandboxDoc` が組んでいた CSP(字を固定する ── 正本を呼んで比べると空振りする)。 */
const LEGACY = (img: string): string =>
  "default-src 'self' data: blob:; " +
  `img-src ${img}; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'";

const directive = (csp: string, name: string): string | null =>
  csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s === name || s.startsWith(`${name} `)) ?? null;

describe('🔴 既定の CSP は前と完全一致', () => {
  it.each([false, true])('外部画像=%s', (img) => {
    const legacyImg = img ? '* data: blob:' : 'data: blob:';
    expect(buildSandboxCsp(img)).toBe(LEGACY(legacyImg));
    expect(buildSandboxCsp(img, DEFAULT_WIDGET_PERMISSIONS)).toBe(LEGACY(legacyImg));
  });

  it('箱の文書の CSP の meta も既定では前と同じ字', () => {
    const doc = buildHtmlSandboxDoc('<p>x</p>', 'id1', false);
    expect(doc).toContain(`content="${LEGACY('data: blob:').replace(/"/g, '&quot;')}"`);
  });
});

describe('🔴 権限ごとに開く項目だけ開く', () => {
  it('外部スクリプトだけ → script / style / font だけ開き、connect は none のまま', () => {
    const csp = buildSandboxCsp(false, { externalScripts: true, network: false });
    expect(directive(csp, 'script-src')).toBe("script-src 'unsafe-inline' https: http:");
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline' https: http:");
    expect(directive(csp, 'font-src')).toBe("font-src 'self' data: blob: https: http:");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
    expect(directive(csp, 'img-src')).toBe('img-src data: blob:');
  });

  it('通信だけ → connect だけ開き、script は inline のみのまま', () => {
    const csp = buildSandboxCsp(false, { externalScripts: false, network: true });
    expect(directive(csp, 'connect-src')).toBe('connect-src https: http: wss: ws:');
    expect(directive(csp, 'script-src')).toBe("script-src 'unsafe-inline'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, 'font-src')).toBeNull();
  });

  it.each([
    { externalScripts: false, network: false },
    { externalScripts: true, network: false },
    { externalScripts: false, network: true },
    { externalScripts: true, network: true },
  ])('どの組み合わせでも閉じたままの項目(%o)', (p) => {
    for (const img of [false, true]) {
      const csp = buildSandboxCsp(img, p);
      expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
      expect(directive(csp, 'object-src')).toBe("object-src 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
      expect(csp).not.toContain('unsafe-eval');
      expect(directive(csp, 'default-src')).toBe("default-src 'self' data: blob:");
    }
  });

  it('箱の文書へも同じ CSP が載る(第 5 引数)', () => {
    const doc = buildHtmlSandboxDoc('<p>x</p>', 'id1', false, '', { externalScripts: true, network: true });
    expect(doc).toContain('connect-src https: http: wss: ws:');
    expect(doc).toContain("script-src 'unsafe-inline' https: http:");
  });

  it('🔴 直書きの箱(buildHtmlSandboxIframe)は常に厳格(権限の口が無い)', () => {
    const html = buildHtmlSandboxIframe('<script src="https://cdn.example/x.js"></script>', '', 0, true, 'w', {});
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain('https: http:');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    // 引数の数(権限を受け取る口を足していない)
    expect(buildHtmlSandboxIframe.length).toBeLessThanOrEqual(6);
  });
});

describe('止めた項目 → 足りない権限', () => {
  it.each([
    [['script-src'], ['external-scripts']],
    [['script-src-elem'], ['external-scripts']],
    [['style-src'], ['external-scripts']],
    [['style-src-elem'], ['external-scripts']],
    [['font-src'], ['external-scripts']],
    [['connect-src'], ['network']],
    [['connect-src', 'script-src-elem', 'font-src'], ['external-scripts', 'network']],
    [['frame-src', 'object-src', 'img-src', 'base-uri'], []],
    [[], []],
  ])('%j → %j', (kinds, want) => {
    expect(blockedWidgetPermissions(kinds)).toEqual(want);
  });
});

describe('文言', () => {
  it('表示名・説明・案内帯に使わない語が無い', () => {
    const texts = [
      ...WIDGET_PERMISSIONS.flatMap((p) => [WIDGET_PERMISSION_LABELS[p].label, WIDGET_PERMISSION_LABELS[p].description]),
      widgetPermissionNoticeText(['external-scripts', 'network']),
    ];
    for (const t of texts) for (const b of BANNED_TERMS) expect(b.pattern().test(t), `「${b.banned}」: ${t}`).toBe(false);
    expect(WIDGET_PERMISSION_LABELS['external-scripts'].label).toBe('外部スクリプト・スタイルの読み込み');
    expect(WIDGET_PERMISSION_LABELS.network.label).toBe('外部への通信');
  });

  it('grantedWidgetPermissions は定義順', () => {
    expect(grantedWidgetPermissions({ externalScripts: true, network: true })).toEqual(['external-scripts', 'network']);
    expect(grantedWidgetPermissions(DEFAULT_WIDGET_PERMISSIONS)).toEqual([]);
  });
});
