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
  LAUNCHER_APP_ALLOW,
  LAUNCHER_APP_PATH,
  launcherAppBase,
  LAUNCHER_APP_SANDBOX,
} from '../../src/features/launcher/app-shell';
import { isAppMime, tileFrom } from '../../src/features/launcher/tiles';

/**
 * 🔴 **本番と同じ形で組む**(P8 段⑭)。
 *
 * 段⑭ で外殻に「保存領域を貸す」経路が入り、`appId` を渡した形と渡さない形で
 * **出力が別物**になった(prelude と受け口の有無)。`launch-tile.ts` は常に
 * `appId: tile.lid` を渡すので、**渡さない形で当てた assertion は空振り**である
 * ── 実際、この file の隔離の pin は一度そうなった(「外殻は script を持たない」が
 * `appId` 無しの呼び方に救われて緑のままだった)。以後ここを通す。
 */
/**
 * ⚠ 渡すのは **配信ディレクトリ**(`document.baseURI` 相当)── 2026-08-06 に
 * `location.origin` から変えた(user 報告 minor)。project Pages では配信が
 * `/PKC3/` なので、origin の根を基点にすると**配信の外**を指す。
 */
const BASE = launcherAppBase('http://x.test/PKC3/');
const shell = (html: string, title = '題'): string =>
  buildLauncherAppShell(title, html, { appId: 'a1', base: BASE });

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
    const html = shell('<script>fetch("/steal")</scr' + 'ipt>');
    // ⚠ `toContain('sandbox="…"')` は**前方一致**なので、末尾に権限を足されても
    // 通ってしまう ── **生成物そのもの**に禁止語を当てる(定数の pin は上の it)。
    // 🔴 これは空振りだった(P7b review の再レビューで発覚)。定数を汚す変異は
    // 上で落ちるが、**組み立て側で足す**変異はここが唯一の関門である
    expect(html).toContain(`sandbox="${LAUNCHER_APP_SANDBOX}"`);
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('srcdoc="');
    // 🔴 **添付の中身が素の markup として出ない**。⚠ 段⑭ で外殻自身が script を
    //    1 本持つようになったので「`<script>` が 1 つも無い」では当てられない ──
    //    **添付の中身そのもの**を当てる(こちらは足しても薄まらない)
    expect(html).not.toContain('fetch("/steal")');
    expect(html).toContain('&lt;script&gt;');
    // ⚠ 素の `<script>` は**外殻のもの 1 本だけ**(添付由来が混ざったら増える)
    expect(html.match(/<script>/g) ?? []).toHaveLength(1);
  });

  it('🔴 `"` が閉じても属性から抜けない', () => {
    // 抜けると `srcdoc="…"` の外に markup を置けてしまう = 外殻の中で実行される
    const html = shell('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('"><img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('escape は `&` を先にやる(自分が作った実体参照を壊さない)', () => {
    expect(escapeForSrcdoc('&lt;')).toBe('&amp;lt;');
    expect(escapeForSrcdoc('a<b>"c"&d')).toBe('a&lt;b&gt;&quot;c&quot;&amp;d');
  });

  it('題名も escape する(題名は user データである)', () => {
    const html = shell('x', '<b>危</b>');
    expect(html).toContain('<title>&lt;b&gt;危&lt;/b&gt;</title>');
    expect(html).not.toContain('<title><b>');
  });

  /**
   * 🔴 P8 段⑭ で**受け口ができた**(保存を届けるため)。段⑩ の
   * 「外殻は聴かない」という pin はここで役目を終える ── 代わりに
   * **「聴くが、自分の iframe 以外は 1 件も受けない」**を pin する。
   *
   * 実測(3 方向の攻撃を実際に打った):
   * ```
   * {"origin":"null",                  "okSource":true,  "reason":"setItem", "keys":"legit"}
   * {"origin":"http://localhost:45732","okSource":false, "reason":"attack3", "keys":"PWNED3"}
   * {"origin":"null",                  "okSource":false, "reason":"attack2", "keys":"PWNED"}
   * {"origin":"null",                  "okSource":false, "reason":"attack1", "keys":"PWNED1"}
   * ```
   * ── **3 通とも外殻まで届く**。そして `event.origin` は**両方向に嘘をつく**:
   * 正規も攻撃 1・2 も一律 `"null"`、逆に外殻自身の攻撃(3)は**アプリ origin を
   * 名乗る**。効いたのは `event.source` の同一性判定だけだった。
   */
  it('🔴 受け口は **source の同一性だけ**で判定する(origin は使わない)', () => {
    const html = shell('<p>a</p>');
    expect(html).toContain('addEventListener("message"');
    // ⚠ **これが本体** ── 判定が `contentWindow` の同一性であること
    expect(html).toContain('e.source!==frame.contentWindow');
    // 🔴 `origin` を判定に混ぜた瞬間に穴が開く(自己なりすましが通る)
    expect(html).not.toContain('e.origin');
    expect(html).not.toContain('event.origin');
  });

  it('保存領域を貸さないときは受け口を作らない(要らない口を開けない)', () => {
    const html = buildLauncherAppShell('題', '<p>a</p>');
    // 🔴 見るのは「**外殻が message を聴くか**」── そこが穴になる面である。
    //    ⚠ かつては `addEventListener` の**語**を禁じていたが、それでは
    //    「囲いの中(アプリ document)で click を聴く」ような、外殻に口を開けない
    //    prelude まで一緒に禁じてしまう(2026-08-05 のページ内リンクの手当てが
    //    まさにそれ)── 禁じる対象を**外殻の message 受け口**に絞る
    expect(html).not.toContain('addEventListener("message"');
    expect(html).not.toContain('localStorage');
    // ⚠ 語の禁止を緩めたので、**貸すときは本当に口が開く**ことも併せて見る
    //    (緩めたことで検査が空振りになっていないかの担保)
    expect(buildLauncherAppShell('題', '<p>a</p>', { appId: 'a1' })).toContain(
      'addEventListener("message"',
    );
  });

  /**
   * P8 段⑭: 隔離したまま SPA を動かすための 2 つ。どちらも origin を渡さない。
   */
  it('🔴 相対 URL の解決先は **階層 URL**(opaque path だと new URL が落ちる)', () => {
    const html = shell('<!doctype html><html><body>x</body></html>');
    expect(html).toContain(`&lt;base href=&quot;${BASE}&quot;&gt;`);
    // 🔴 実測で 1 度外した ── `about:srcdoc` / blob: は opaque path なので
    //    `new URL('assets/app.js', document.baseURI)` が TypeError で落ち、
    //    SPA が**そこで死ぬ**。base はスキーム付きの階層 URL でなければならない
    expect(BASE.startsWith('http://x.test/')).toBe(true);
    expect(() => new URL('assets/app.js', BASE)).not.toThrow();
    // 🔴 **origin の根にしない** ── 根にすると `assets/…` が PKC3 自身の資産に
    //    解決して、アプリの中に PKC3 の JS が降ってくる
    expect(BASE).not.toBe('http://x.test/');
    // 🔴 **配信ディレクトリの下**に居る(2026-08-06)── origin の根から数えると、
    //    `<user>.github.io` のような**共有 origin** では他の project の
    //    `/pkc3-app/` に当たりうる(「専用のパス」の前提が崩れる)
    expect(BASE).toBe('http://x.test/PKC3/pkc3-app/');
    expect(new URL('assets/app.js', BASE).pathname).toBe(
      `/PKC3${LAUNCHER_APP_PATH}assets/app.js`,
    );
  });

  it('base を渡さないときは `<base>` を焼かない(test / 旧経路)', () => {
    expect(buildLauncherAppShell('題', 'x', { appId: 'a1' })).not.toContain('base href');
  });

  it('🔴 クリップボードは **書く側だけ**渡す', () => {
    expect(LAUNCHER_APP_ALLOW).toContain('clipboard-write');
    // ⚠ read を渡すと、user が他のアプリでコピーした内容を吸える
    expect(LAUNCHER_APP_ALLOW).not.toContain('clipboard-read');
    expect(shell('x')).toContain(`allow="${LAUNCHER_APP_ALLOW}"`);
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
