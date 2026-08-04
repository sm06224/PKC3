/** @vitest-environment node */
/**
 * P8 段⑭: 隔離したままアプリに**保存領域を貸す** prelude の組み立て。
 *
 * 🔴 直す前の実測(実起動で回収):
 * ```
 * SecurityError: Failed to read the 'sessionStorage' property from 'Window':
 *   The document is sandboxed and lacks the 'allow-same-origin' flag.
 * → #app は「読み込み中…」のまま / spaBoot 未設定
 * ```
 * `window.localStorage` の**プロパティ読みそのもの**が同期に投げるので、
 * `try/catch` を書いていないアプリは **1 行目で止まる**。
 *
 * ⚠ ここは**文字列を組む所**の test。実際に差し替わって動くか・保存が残るかは
 * `tests/smoke/launcher.smoke.spec.ts` が実ブラウザで見る ── **両端に置く**。
 */
import { describe, expect, it } from 'vitest';
import {
  APP_STORAGE_LIMIT,
  APP_STORAGE_MESSAGE,
  appStoragePrefix,
  buildStorageShim,
  inlineJson,
  insertPrelude,
} from '../../src/features/launcher/app-storage-shim';

describe('インライン script への埋め込み', () => {
  it('🔴 `</script>` で script が閉じない(JSON.stringify だけでは足りない)', () => {
    // 実測で踏んだ: 値の中の `</script>` が**その場で script を閉じ**、外殻が
    // 初期化されず全 test が timeout した。JSON.stringify は `<` を escape しない
    const out = inlineJson({ x: '</scr' + 'ipt><img onerror=alert(1)>' });
    expect(out).not.toContain('</scr' + 'ipt>');
    expect(out).not.toContain('<img');
    expect(out).toContain('\\u003c');
    // ⚠ **読み戻せる**(escape して壊したら意味がない)
    expect(JSON.parse(out)).toEqual({ x: '</scr' + 'ipt><img onerror=alert(1)>' });
  });

  it('日本語も壊さない', () => {
    expect(JSON.parse(inlineJson({ k: 'メモ🍎' }))).toEqual({ k: 'メモ🍎' });
  });
});

describe('prelude を挿す場所', () => {
  it('🔴 doctype の**直後**に挿す(先頭に置くと quirks mode に落ちる)', () => {
    // 実測: preludeBeforeDoctype → BackCompat / preludeAfterDoctype → CSS1Compat
    const out = insertPrelude('<!doctype html><html><body>x</body></html>', '<P>');
    expect(out).toBe('<!doctype html><P><html><body>x</body></html>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('⚠ doctype が無ければ先頭(足すとアプリの箱の計算が変わる)', () => {
    // doctype の無い HTML はもともと quirks mode ── こちらが `<!doctype html>` を
    // 補うと**アプリの見た目が変わる**。「直接開いたときと同じ」を守る
    const out = insertPrelude('<html><body>x</body></html>', '<P>');
    expect(out).toBe('<P><html><body>x</body></html>');
    expect(out).not.toContain('<!doctype');
  });

  it('BOM・空白・コメントが前にあっても doctype を見つける', () => {
    const out = insertPrelude('﻿\n<!-- c -->\n<!DOCTYPE HTML>\n<html>', '<P>');
    expect(out).toContain('<!DOCTYPE HTML><P>');
    expect(out.indexOf('<P>')).toBeGreaterThan(out.indexOf('<!DOCTYPE HTML>'));
  });
});

describe('貸す保存領域', () => {
  it('名前空間はアプリごとに分かれる(他のアプリのものが見えない)', () => {
    expect(appStoragePrefix('e-1')).toBe('pkc3.app.e-1.');
    expect(appStoragePrefix('e-1')).not.toBe(appStoragePrefix('e-2'));
    // ⚠ PKC3 自身の鍵(`pkc3.theme`)と**前方一致しない**
    expect('pkc3.theme'.startsWith(appStoragePrefix('e-1'))).toBe(false);
  });

  it('🔴 shim は Proxy を使う(素のオブジェクトでは 15 項目中 15 不一致)', () => {
    const src = buildStorageShim({ seed: {} });
    // ドット読み・`in`・`delete`・`Object.keys`・`JSON.stringify` を成立させるのは
    // Proxy の trap ── これが無いと「動くように見えて全部違う」ものになる
    expect(src).toContain('new Proxy');
    expect(src).toContain('ownKeys');
    expect(src).toContain('getOwnPropertyDescriptor');
    // `[object Storage]` / `instanceof Storage` は prototype を継がせて直す
    expect(src).toContain('Storage.prototype');
  });

  it('🔴 **for...in を使わない**(prototype の getter を実 Storage 以外で呼ぶと落ちる)', () => {
    // 実測: `TypeError: Illegal invocation` で SPA が 1 行目で止まった ──
    // 直す前とまったく同じ症状になるので、ここは形で止める
    const src = buildStorageShim({ seed: {} });
    expect(src).not.toMatch(/for\s*\(\s*var\s+\w+\s+in\s/);
  });

  it('🔴 上限を**同期に**投げる(投げないと静かに食い続ける)', () => {
    const src = buildStorageShim({ seed: {} });
    expect(src).toContain('QuotaExceededError');
    expect(src).toContain(String(APP_STORAGE_LIMIT));
  });

  it('前回の中身が焼き込まれる(1 行目から同期に読める)', () => {
    const src = buildStorageShim({ seed: { notes: '["メモ"]' } });
    expect(src).toContain(inlineJson({ notes: '["メモ"]' }));
  });

  it('⚠ 差分だけ送る(全量スナップショットは O(N²) で、2 タブでデータが消える)', () => {
    const src = buildStorageShim({ seed: {} });
    expect(src).toContain(inlineJson(APP_STORAGE_MESSAGE));
    for (const op of ['set', 'remove', 'clear']) expect(src).toContain(`op: '${op}'`);
  });

  it('sessionStorage は**往復させない**(タブ単位なので保存の意味が無い)', () => {
    const src = buildStorageShim({ seed: {} });
    // local は send を渡し、session は何もしない関数を渡す
    expect(src).toContain('build(seed, send)');
    expect(src).toContain("install('sessionStorage'");
  });
});

/**
 * 🔴 **shim を実際に走らせる**(P8 段⑭)。
 *
 * 変異試験で「上限を投げない」が**生き残った** ── 上の test は生成物に
 * `QuotaExceededError` と上限の数値が**在るか**しか見ておらず、`throw` の行を
 * 消しても両方の文字列が残るので緑のままだった(この repo の規律:
 * 「それらしいものが在るか」ではなく「**当の振る舞い**」で書く)。
 *
 * shim は素の JS なので **node で走る**。`window` と `parent` を差せば、
 * ブラウザを起こさずに意味論を直接確かめられる。
 */
function runShim(
  seed: Record<string, string>,
  limit = APP_STORAGE_LIMIT,
): { ls: Storage; sent: Array<Record<string, string>> } {
  const src = buildStorageShim({ seed, limit }).replace(/^<script>/, '').replace(/<\/script>$/, '');
  const win: Record<string, unknown> = {};
  const sent: Array<Record<string, string>> = [];
  new Function('window', 'parent', src)(win, {
    postMessage: (m: Record<string, string>) => sent.push(m),
  });
  return { ls: win.localStorage as Storage, sent };
}

describe('shim の意味論(実際に走らせる)', () => {
  it('🔴 上限を超えたら **同期に** QuotaExceededError を投げる', () => {
    const { ls } = runShim({}, 64);
    ls.setItem('a', 'x'.repeat(50)); // 51 バイト ── 通る
    expect(ls.getItem('a')).toBe('x'.repeat(50));
    // ⚠ ここが本丸 ── 投げないと「上限で古いものを捨てる」型のアプリが
    //    永久に捨てず、ノート本体と同じ財布を静かに食い続ける
    let name = '';
    try {
      ls.setItem('b', 'y'.repeat(50));
    } catch (e) {
      name = (e as Error).name;
    }
    expect(name).toBe('QuotaExceededError');
    expect(ls.getItem('b'), '上限を超えた書込が入ってしまっている').toBeNull();
  });

  it('⚠ 上書きは**差し引き**で数える(同じ鍵を書き直せなくならない)', () => {
    const { ls } = runShim({}, 64);
    ls.setItem('a', 'x'.repeat(50));
    expect(() => ls.setItem('a', 'z'.repeat(50))).not.toThrow();
    expect(ls.getItem('a')).toBe('z'.repeat(50));
  });

  it('🔴 本物と同じ触り方が全部できる(素のオブジェクトでは 15/15 不一致だった)', () => {
    const { ls } = runShim({ seeded: 'S' });
    // 1 行目から seed が読める(同期)
    expect(ls.getItem('seeded')).toBe('S');
    ls.setItem('a', '1');
    // ドット読み / ドット書き
    expect((ls as unknown as Record<string, string>).a).toBe('1');
    (ls as unknown as Record<string, string>).b = '2';
    expect(ls.getItem('b')).toBe('2');
    // 数値も文字列になる(本物の意味論)
    (ls as unknown as Record<string, unknown>).n = 5;
    expect(ls.getItem('n')).toBe('5');
    // 列挙まわり
    expect(Object.keys(ls).sort()).toEqual(['a', 'b', 'n', 'seeded']);
    expect(JSON.parse(JSON.stringify(ls))).toEqual({ seeded: 'S', a: '1', b: '2', n: '5' });
    expect('a' in ls).toBe(true);
    expect('zzz' in ls).toBe(false);
    expect(ls.length).toBe(4);
    expect(ls.key(0)).toBe('seeded');
    expect(ls.key(99)).toBeNull();
    // delete / removeItem / clear
    delete (ls as unknown as Record<string, string>).a;
    expect(ls.getItem('a')).toBeNull();
    ls.removeItem('b');
    expect(ls.length).toBe(2);
    ls.clear();
    expect(ls.length).toBe(0);
    expect(ls.getItem('seeded')).toBeNull();
  });

  it('🔴 変更は**差分で**外殻へ飛ぶ(全量スナップショットを送らない)', () => {
    const { ls, sent } = runShim({});
    ls.setItem('a', '1');
    (ls as unknown as Record<string, string>).b = '2';
    ls.removeItem('a');
    ls.clear();
    expect(sent.map((m) => m.op)).toEqual(['set', 'set', 'remove', 'clear']);
    expect(sent[0]).toMatchObject({ op: 'set', key: 'a', value: '1', tag: APP_STORAGE_MESSAGE });
    // ⚠ 全量を積んでいない(値は 1 件ぶんだけ)
    expect(Object.keys(sent[1]!).sort()).toEqual(['key', 'op', 'tag', 'value']);
  });

  it('⚠ 上限に当たった書込は**外殻へ送らない**(入っていないものを保存しない)', () => {
    const { ls, sent } = runShim({}, 32);
    try {
      ls.setItem('a', 'x'.repeat(100));
    } catch {
      /* 期待どおり */
    }
    expect(sent).toEqual([]);
  });

  it('sessionStorage は**別物**で、外殻へ送らない(タブ単位)', () => {
    const src = buildStorageShim({ seed: { k: 'v' } })
      .replace(/^<script>/, '')
      .replace(/<\/script>$/, '');
    const win: Record<string, unknown> = {};
    const sent: unknown[] = [];
      new Function('window', 'parent', src)(win, { postMessage: (m: unknown) => sent.push(m) });
    const ss = win.sessionStorage as Storage;
    // ⚠ seed を引き継がない(タブ単位なので前回の続きではない)
    expect(ss.getItem('k')).toBeNull();
    ss.setItem('s', '1');
    expect(ss.getItem('s')).toBe('1');
    expect((win.localStorage as Storage).getItem('s'), 'local と session が同じ器').toBeNull();
    expect(sent, 'session の書込を外殻へ送っている').toEqual([]);
  });
});
