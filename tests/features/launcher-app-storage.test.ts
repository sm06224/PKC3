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

  it('🔴 lid に `.` が入っても分離が壊れない(PKC2 取込は lid を素通しする)', () => {
    // 直す前: lid "a" の鍵 "b.c" と lid "a.b" の鍵 "c" が**どちらも**
    // `pkc3.app.a.b.c` になり、別のアプリのデータを読み書きできた
    const outer = appStoragePrefix('a');
    const inner = appStoragePrefix('a.b');
    expect(`${outer}b.c`).not.toBe(`${inner}c`);
    // ⚠ 一方が他方の前置きになっていない(走査は前方一致で消す)
    expect(inner.startsWith(outer), 'lid "a" の走査が lid "a.b" まで巻き込む').toBe(false);
    // 他の区切り文字でも同じ
    for (const lid of ['a/b', 'a b', 'a%2Eb', 'a.b.c']) {
      expect(appStoragePrefix(lid)).not.toBe(appStoragePrefix('a'));
      expect(appStoragePrefix(lid).startsWith(appStoragePrefix('a'))).toBe(false);
    }
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
    expect(src).toContain('build(seed, send, true)');
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
): {
  ls: Storage;
  ss: Storage;
  sent: Array<Record<string, string>>;
  /** 外殻からの返事(P8 段⑯)。`ok:false` で像を巻き戻す。 */
  ack(seq: number, ok: boolean): void;
} {
  const src = buildStorageShim({ seed, limit }).replace(/^<script>/, '').replace(/<\/script>$/, '');
  const listeners: Array<(e: { data: unknown }) => void> = [];
  const win: Record<string, unknown> = {
    addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => listeners.push(fn),
  };
  const sent: Array<Record<string, string>> = [];
  new Function('window', 'parent', src)(win, {
    postMessage: (m: Record<string, string>) => sent.push(m),
  });
  return {
    ls: win.localStorage as Storage,
    ss: win.sessionStorage as Storage,
    sent,
    ack: (seq, ok) => {
      for (const fn of listeners) fn({ data: { tag: APP_STORAGE_MESSAGE, op: 'ack', seq, ok } });
    },
  };
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
    // ⚠ `seq` は**返事を結び付けるため**の 1 個だけ(値は積まない)
    expect(Object.keys(sent[1]!).sort()).toEqual(['key', 'op', 'seq', 'tag', 'value']);
    expect(sent[1], '前の値まで外殻へ送っている(payload が倍になる)').not.toHaveProperty('__prev');
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
    const { ls, ss, sent } = runShim({ k: 'v' });
    // ⚠ seed を引き継がない(タブ単位なので前回の続きではない)
    expect(ss.getItem('k')).toBeNull();
    ss.setItem('s', '1');
    expect(ss.getItem('s')).toBe('1');
    expect(ls.getItem('s'), 'local と session が同じ器').toBeNull();
    expect(sent, 'session の書込を外殻へ送っている').toEqual([]);
  });

  /**
   * 🔴 **外殻に入らなかった書込を「入った」と見せ続けない**(P8 段⑯。レビュー H-3)。
   *
   * 直す前の実測: 別のアプリが origin の枠を埋めていると、こちらの
   * `setItem('mine', …)` は**例外 none・読み戻しも成功**なのに、
   * 次回起動で 1 件も残っていなかった(外殻の書込が黙って落ちていた)。
   */
  it('🔴 外殻が断ったら像を巻き戻し、次の setItem で投げる', () => {
    const { ls, sent, ack } = runShim({});
    ls.setItem('a', '1');
    ls.setItem('mine', 'B');
    expect(ls.getItem('mine')).toBe('B');
    const seq = Number(sent[1]!.seq);
    expect(seq, '外殻が返事を返せる印(seq)が付いていない').toBeGreaterThan(0);

    ack(seq, false); // 外殻が「入らなかった」と返す
    // ⚠ **像から消える**(在ると見せ続けない)
    expect(ls.getItem('mine'), '外殻に入っていないのに在ると見せている').toBeNull();
    // ⚠ 次の書込で**同期に**投げる(アプリが気づける)
    let name = '';
    try {
      ls.setItem('next', 'x');
    } catch (e) {
      name = (e as Error).name;
    }
    expect(name, '断られたことがアプリに伝わらない').toBe('QuotaExceededError');
    // ⚠ 1 度知らせたら復帰する(永久に書けなくならない)
    expect(() => ls.setItem('next', 'x')).not.toThrow();
  });

  it('⚠ 通った書込は巻き戻さない(ok の ack で像が壊れない)', () => {
    const { ls, sent, ack } = runShim({});
    ls.setItem('a', '1');
    ack(Number(sent[0]!.seq), true);
    expect(ls.getItem('a')).toBe('1');
    expect(() => ls.setItem('b', '2')).not.toThrow();
  });

  it('⚠ 上書きを断られたら**前の値へ**戻る(消えたことにしない)', () => {
    const { ls, sent, ack } = runShim({ a: '旧' });
    ls.setItem('a', '新');
    ack(Number(sent[0]!.seq), false);
    expect(ls.getItem('a'), '断られた上書きで前の値まで失われた').toBe('旧');
  });
});
