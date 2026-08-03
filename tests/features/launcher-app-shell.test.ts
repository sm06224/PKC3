/** @vitest-environment node */
/**
 * P7b review H-1: 取り込んだ HTML を**アプリと同じ origin で走らせない**。
 *
 * 実測(修正前、smoke で計測):
 * ```
 * {"origin":"http://localhost:45732","ls":2,"idb":"pkc3-assets","opfs":".pkc3"}
 * ```
 * `localStorage` に書け、IndexedDB(添付の実体)と OPFS(SQLite 本体)を
 * 列挙できていた。ここは**その穴を塞ぐ器**の test。
 */
import { describe, expect, it } from 'vitest';
import {
  buildLauncherAppShell,
  escapeForSrcdoc,
  LAUNCHER_APP_SANDBOX,
} from '../../src/features/launcher/app-shell';
import { isAppMime, tileFrom } from '../../src/features/launcher/tiles';

describe('ランチャーの外殻', () => {
  it('🔴 `allow-same-origin` を**含まない**', () => {
    // ⚠ 「sandbox が付いている」だけでは足りない ── 権限の中身が本体である
    expect(LAUNCHER_APP_SANDBOX).not.toContain('allow-same-origin');
    // ⚠ popup が sandbox を**脱げる**指定も禁止(付けると外殻の意味が消える)
    expect(LAUNCHER_APP_SANDBOX).not.toContain('allow-popups-to-escape-sandbox');
    expect(LAUNCHER_APP_SANDBOX).not.toContain('allow-top-navigation');
    expect(LAUNCHER_APP_SANDBOX.split(' ')).toContain('allow-scripts');
  });

  it('🔴 添付の HTML は **srcdoc の中に escape されて**入る(素の markup として出ない)', () => {
    const html = buildLauncherAppShell('題', '<script>fetch("/steal")</scr' + 'ipt>');
    expect(html).toContain(`sandbox="${LAUNCHER_APP_SANDBOX}"`);
    expect(html).toContain('srcdoc="');
    // ⚠ 外殻の DOM に**素の script が生えない**ことが主張(escape の抜けの検出)
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('🔴 `"` が閉じても属性から抜けない', () => {
    // 抜けると `srcdoc="…"` の外に markup を置けてしまう = 外殻の中で実行される
    const html = buildLauncherAppShell('題', '"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('escape は `&` を先にやる(自分が作った実体参照を壊さない)', () => {
    expect(escapeForSrcdoc('&lt;')).toBe('&amp;lt;');
    expect(escapeForSrcdoc('a<b>"c"&d')).toBe('a&lt;b&gt;&quot;c&quot;&amp;d');
  });

  it('題名も escape する(題名は user データである)', () => {
    const html = buildLauncherAppShell('<b>危</b>', 'x');
    expect(html).toContain('<title>&lt;b&gt;危&lt;/b&gt;</title>');
    expect(html).not.toContain('<title><b>');
  });

  it('外殻自身は script を持たない(受け口を作らない)', () => {
    // iframe から parent へ話しかけられても、聴く相手が居ない
    expect(buildLauncherAppShell('題', '<p>a</p>')).not.toContain('addEventListener');
  });
});

describe('アプリとして開ける種別', () => {
  it('HTML と mime 未設定だけ', () => {
    expect(isAppMime('text/html')).toBe(true);
    expect(isAppMime('text/html; charset=utf-8')).toBe(true);
    expect(isAppMime('application/xhtml+xml')).toBe(true);
    expect(isAppMime(undefined)).toBe(true);
  });

  it('🔴 script が動く別種別を**混ぜない**', () => {
    // svg / xml は最上位文書として開くと script が動く種別 ── 器に入れても
    // 文字化けにしかならないので、そもそもタイルにしない
    expect(isAppMime('image/svg+xml')).toBe(false);
    expect(isAppMime('application/pdf')).toBe(false);
    expect(isAppMime('text/xml')).toBe(false);
    expect(isAppMime('application/octet-stream')).toBe(false);
  });

  it('HTML でない添付はタイルにならない(押しても中身が出せない)', () => {
    const body = (mime: string): string =>
      `---\nattachment.registered_as_app: true\nattachment.asset_key: k\nattachment.mime: ${mime}\n---\n`;
    expect(tileFrom({ lid: 'a', title: 'a', body: body('text/html') })).not.toBeNull();
    expect(tileFrom({ lid: 'a', title: 'a', body: body('application/pdf') })).toBeNull();
  });
});
