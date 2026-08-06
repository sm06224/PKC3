/**
 * 🔴 **ページ内リンクでアプリが消えない**(2026-08-05、調査 doc 1-7)。
 *
 * `srcdoc` + `<base>` の組み合わせでは `<a href="#sec">` が
 * `…/pkc3-app/#sec` に解決され、document URL(`about:srcdoc`)と別文書なので
 * **本当に遷移する** ── 行き先は SPA fallback の PKC3 index.html で、
 * 不透明オリジンでは起動できず真っ白になる。**JS を 1 行も使わないアプリでも起きる。**
 *
 * ⚠ ここは**文字列を組む pure module**の unit。実際にクリックして遷移しないことは
 * `tests/smoke/launcher.smoke.spec.ts` が実ブラウザで見る(生成 ≠ 挙動)。
 */
import { describe, expect, it } from 'vitest';
import { APP_ERROR_FIELD, buildAnchorShim } from '@features/launcher/app-anchor-shim';
import { buildLauncherAppShell } from '@features/launcher/app-shell';

const shim = buildAnchorShim();

describe('ページ内リンクの手当て(文字列)', () => {
  it('click を聴いて既定を止める', () => {
    expect(shim).toContain('addEventListener("click"');
    expect(shim).toContain('ev.preventDefault()');
  });

  it('🔴 アプリが自分で扱ったら手を出さない(routing を奪わない)', () => {
    expect(shim).toContain('if(ev.defaultPrevented)return;');
  });

  it('🔴 **バブリング段**で聴く(capture でアプリより先に止めない)', () => {
    // capture で先に止めると、ページ内リンクを自分で扱う SPA の動作を壊す
    expect(shim).toContain('},false);');
  });

  it('🔴 判定は **属性の生値**(`a.href` は base で絶対化されて判別できない)', () => {
    expect(shim).toContain('a.getAttribute("href")');
    expect(shim).toContain('href.charAt(0)!=="#"');
    expect(shim).not.toContain('a.href');
  });

  it('修飾キー / 中クリック / target 指定は尊重する(別タブの意図を潰さない)', () => {
    expect(shim).toContain('ev.button!==0');
    expect(shim).toContain('ev.metaKey');
    expect(shim).toContain('tgt!=="_self"');
  });

  it('id と name の両方で探す(素の HTML の古いアンカー)', () => {
    expect(shim).toContain('getElementById');
    expect(shim).toContain('getElementsByName');
  });

  it('🔴 死んだことを言う(真っ白 + 理由なしを作らない)', () => {
    expect(shim).toContain('addEventListener("error"');
    expect(shim).toContain('addEventListener("unhandledrejection"');
    expect(shim).toContain(APP_ERROR_FIELD);
    // ⚠ 画像の読み込み失敗を「アプリが死んだ」と出さない
    expect(shim).toContain('e.target&&e.target!==window');
  });

  it('アプリの変数を汚さない(即時関数で閉じる)', () => {
    expect(shim.startsWith('<script>(function(){')).toBe(true);
    expect(shim.endsWith('})()</script>')).toBe(true);
  });
});

describe('外殻に必ず入る', () => {
  const has = (html: string): boolean => html.includes('a[href]');

  it('🔴 保存領域を貸す / 貸さないに関わらず入る', () => {
    // ⚠ 遷移はアプリの作りに関係なく起きる ── 条件付きで入れると穴が残る
    expect(has(buildLauncherAppShell('題', '<p>a</p>'))).toBe(true);
    expect(has(buildLauncherAppShell('題', '<p>a</p>', { appId: 'a1' }))).toBe(true);
  });

  it('🔴 素のまま(同一オリジン)でも入る', () => {
    // document URL は `about:srcdoc` のままなので、同じ理屈で遷移する
    expect(has(buildLauncherAppShell('題', '<p>a</p>', { sameOrigin: true }))).toBe(true);
  });

  it('🔴 doctype より後ろに入る(quirks mode に落とさない)', () => {
    const html = buildLauncherAppShell('題', '<!doctype html><html><body>x</body></html>', {
      appId: 'a1',
      base: 'http://x.test/pkc3-app/',
    });
    const doctype = html.indexOf('&lt;!doctype html&gt;');
    const anchor = html.indexOf('a[href]');
    expect(doctype).toBeGreaterThan(-1);
    expect(anchor).toBeGreaterThan(doctype);
  });
});
