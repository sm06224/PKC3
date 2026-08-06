/** @vitest-environment happy-dom */
/**
 * 🔴 **囲いの中で「無い能力」に触っても 1 行目で死なない**(2026-08-06。user 報告 2-15)。
 *
 * 不透明オリジンでは `indexedDB` / `caches` / `navigator.storage` /
 * `navigator.serviceWorker` / `document.cookie` が**プロパティ読みで同期に投げる**。
 * `try/catch` を書いていないアプリはそこで止まり、画面は黒いまま理由が出ない。
 *
 * ⚠ **文字列の assert だけでは守れない**(生成 ≠ 挙動)。ここでは shim を
 * **実際に走らせて**、投げるプロパティが「読める・無いものとして見える」に
 * 変わることを見る ── そのために happy-dom 上で**投げる getter を仕込む**。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_CAPABILITY_FIELD,
  SANDBOX_ABSENT,
  buildCapabilityShim,
} from '@features/launcher/app-sandbox-shim';
import { buildLauncherAppShell } from '@features/launcher/app-shell';

/** 不透明オリジンの再現 ── 読むだけで投げる own プロパティを置く。 */
function makeThrow(host: object, name: string): void {
  Object.defineProperty(host, name, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(`SecurityError: ${name} is sandboxed`);
    },
  });
}

const touched: Array<[object, string]> = [];
function sandbox(host: object, name: string): void {
  makeThrow(host, name);
  touched.push([host, name]);
}

/** shim を**実行する**(`<script>` の皮を剥いで即時実行式として回す)。 */
function runShim(): void {
  const code = buildCapabilityShim().replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function(code)();
}

afterEach(() => {
  for (const [host, name] of touched.splice(0)) {
    delete (host as Record<string, unknown>)[name];
  }
  document.body.textContent = '';
});

const line = (): HTMLElement | null =>
  document.querySelector(`[data-pkc-field="${APP_CAPABILITY_FIELD}"]`);

describe('無い能力の shim(実行)', () => {
  it('🔴 投げるプロパティが「読める・undefined」に変わる(1 行目で死なない)', () => {
    sandbox(window, 'indexedDB');
    expect(() => (window as { indexedDB?: unknown }).indexedDB, '前提: 素では投げる').toThrow();
    runShim();
    let seen: unknown = 'not-read';
    expect(() => {
      seen = (window as { indexedDB?: unknown }).indexedDB;
    }, '差し替えたのに投げる').not.toThrow();
    expect(seen).toBeUndefined();
  });

  it('🔴 触ったことを 1 行出す(黙って無いことにしない)', () => {
    sandbox(window, 'indexedDB');
    runShim();
    expect(line(), '触る前から出ている').toBeNull();
    void (window as { indexedDB?: unknown }).indexedDB;
    expect(line()?.textContent).toContain('IndexedDB');
    expect(line()?.textContent).toContain('囲いの中では使えません');
  });

  it('🔴 2 つ触っても行は 1 枚(画面が埋まらない)', () => {
    sandbox(window, 'indexedDB');
    sandbox(window, 'caches');
    runShim();
    void (window as { indexedDB?: unknown }).indexedDB;
    void (window as { caches?: unknown }).caches;
    expect(
      document.querySelectorAll(`[data-pkc-field="${APP_CAPABILITY_FIELD}"]`),
      '触るたびに行が増えた',
    ).toHaveLength(1);
    expect(line()?.textContent).toContain('IndexedDB');
    expect(line()?.textContent).toContain('Cache API');
  });

  /**
   * ⚠ これは「落ちた」ではなく**お知らせ**である ── 能力を見て代替へ落ちる
   * アプリ(localforage 型)は正常に動いているのに、帯がその画面を覆い続ける。
   */
  it('🔴 押すと閉じる(正常に動いているアプリを覆い続けない)', () => {
    sandbox(window, 'indexedDB');
    runShim();
    void (window as { indexedDB?: unknown }).indexedDB;
    const el = line()!;
    expect(el.textContent).toContain('押すと閉じます');
    el.dispatchEvent(new Event('click', { bubbles: true }));
    expect(line(), '押しても閉じない').toBeNull();
  });

  it('同じものを 2 回触っても名前が重複しない', () => {
    sandbox(window, 'indexedDB');
    runShim();
    void (window as { indexedDB?: unknown }).indexedDB;
    void (window as { indexedDB?: unknown }).indexedDB;
    expect(line()!.textContent!.match(/IndexedDB/g)).toHaveLength(1);
  });

  it('🔴 cookie は **空文字**(undefined にすると `.split` で落ちる)', () => {
    sandbox(document, 'cookie');
    runShim();
    let value: unknown = null;
    expect(() => {
      value = document.cookie;
    }).not.toThrow();
    expect(value).toBe('');
    // ⚠ 書き込みも受けて捨てる(投げない)
    expect(() => {
      document.cookie = 'a=1';
    }).not.toThrow();
    expect(line()?.textContent).toContain('cookie');
  });

  it('navigator 側(storage / serviceWorker)も同じ', () => {
    sandbox(navigator, 'storage');
    sandbox(navigator, 'serviceWorker');
    runShim();
    expect(() => (navigator as { storage?: unknown }).storage).not.toThrow();
    expect(() => (navigator as { serviceWorker?: unknown }).serviceWorker).not.toThrow();
  });

  /**
   * ⚠ **読めるものは触らない**。素のまま(同一オリジン)で開いたときに
   * 差し替えると、**本物の IndexedDB を奪う**ことになる。
   */
  it('🔴 本物が使える環境では 1 つも差し替えない', () => {
    // ⚠ stub は**本物の意味論を真似る** ── `deleteDatabase` を持たない偽物を
    //    置くと probe が TypeError で落ち、「使えない」と誤判定される
    const real = { open: () => 'real', deleteDatabase: () => 'deleted' };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: real });
    touched.push([window, 'indexedDB']);
    runShim();
    expect((window as { indexedDB?: unknown }).indexedDB, '本物を奪った').toBe(real);
    void (window as { indexedDB?: unknown }).indexedDB;
    expect(line(), '使えているのに 1 行出した').toBeNull();
  });

  /**
   * 🔴 **読めるのに使えない**ものがある(2026-08-06 の実測)。
   *
   * 不透明オリジンの `indexedDB` は**プロパティ読みでは投げない**ので、
   * `if (window.indexedDB)` は**真**になる ── そのまま `.open()` を呼んで
   * **1 行目で死ぬ**。読みだけ守る手当てでは、この形が丸ごと素通りする。
   */
  it('🔴 読めるのに使えないものは「無い」にする(触ってみて判定する)', () => {
    const unusable = {
      open() {
        throw new Error('SecurityError: access denied');
      },
      deleteDatabase() {
        throw new Error('SecurityError: access denied');
      },
    };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: unusable });
    touched.push([window, 'indexedDB']);
    expect(() => (window as { indexedDB?: unknown }).indexedDB, '前提: 読みは通る').not.toThrow();
    runShim();
    expect(
      (window as { indexedDB?: unknown }).indexedDB,
      '読めるから素通りした(能力を見るアプリは真と読んで .open で死ぬ)',
    ).toBeUndefined();
    expect(line()?.textContent).toContain('IndexedDB');
  });

  it('アプリの変数を汚さない(即時関数で閉じる)', () => {
    const shim = buildCapabilityShim();
    expect(shim.startsWith('<script>')).toBe(true);
    expect(shim.endsWith('</script>')).toBe(true);
    expect(shim).toContain("'use strict'");
  });
});

describe('外殻に必ず入る', () => {
  const has = (html: string): boolean => html.includes(APP_CAPABILITY_FIELD);

  it('🔴 保存領域を貸す / 貸さない・素のままに関わらず入る', () => {
    // ⚠ 条件付きで入れると、条件が 2 か所になる(shim 自身が本物を見て抜ける)
    expect(has(buildLauncherAppShell('題', '<p>a</p>'))).toBe(true);
    expect(has(buildLauncherAppShell('題', '<p>a</p>', { appId: 'a1' }))).toBe(true);
    expect(has(buildLauncherAppShell('題', '<p>a</p>', { sameOrigin: true }))).toBe(true);
  });

  it('🔴 doctype より後ろに入る(quirks mode に落とさない)', () => {
    const html = buildLauncherAppShell('題', '<!doctype html><html><body>x</body></html>', {
      appId: 'a1',
      base: 'http://x.test/pkc3-app/',
    });
    const doctype = html.indexOf('&lt;!doctype html&gt;');
    expect(doctype).toBeGreaterThan(-1);
    expect(html.indexOf(APP_CAPABILITY_FIELD)).toBeGreaterThan(doctype);
  });

  it('🔴 名前の表と shim が食い違わない(片方だけ足した形を作らない)', () => {
    const shim = buildCapabilityShim();
    for (const name of SANDBOX_ABSENT) {
      expect(shim, `${name} が shim に無い`).toContain(`'${name}'`);
    }
  });
});
