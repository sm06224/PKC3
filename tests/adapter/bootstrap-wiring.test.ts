/** @vitest-environment node */
/**
 * `bootstrap()` の配線(P7)。
 *
 * ⚠ **原文の検査**である。`bootstrap()` は module 読込時に走り、実ブラウザの
 * PWA インストール / SW 登録を要求するので、node の unit からは呼べない ──
 * だからといって「誰も見ていない」で済ませると、**配線を消す変異が全緑で通る**
 * (実際に P7 段⑤ round-2 で 2 件がそうなっていた)。
 *
 * ⚠ 弱い検査だと自覚して使う。ここが守るのは「**呼んでいるか / 順序が正しいか**」
 * だけで、呼んだ結果は各 module の unit と smoke が見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync('src/main.ts', 'utf-8');

/** `bootstrap()` の本体だけを切り出す(他所の一致に救われないように)。 */
function bootstrapBody(): string {
  const at = MAIN.indexOf('function bootstrap()');
  expect(at, 'bootstrap() が無い').toBeGreaterThan(-1);
  return MAIN.slice(at);
}

describe('bootstrap の配線', () => {
  it('🔴 SW の登録を boot の成功側・失敗側の**両方**から呼ぶ', () => {
    // round-2 review L-6: 当初は boot より**前**に登録していたが、`register` は
    // precache(実測 1.6MB)の取得を始めるので、**初回訪問で boot の wasm /
    // worker chunk と帯域を奪い合う**。かといって成功側だけに置くと、
    // 「boot が失敗しても次回オフラインで開ける」(段⑤ の意図)を失う。
    // ⚠ 変異試験で「失敗側の呼び出しを消す」が**生き残った**ので pin する
    const body = bootstrapBody();
    const calls = [...body.matchAll(/registerSw\(\)/g)].length;
    expect(calls, 'registerSw() の呼び出しが 2 か所ない').toBe(2);
    const thenAt = body.indexOf('.then((app)');
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(catchAt).toBeGreaterThan(thenAt);
    // 成功側は `.then` の中、失敗側は `.catch` の中
    expect(body.slice(thenAt, catchAt)).toContain('registerSw()');
    expect(body.slice(catchAt)).toContain('registerSw()');
  });

  it('🔴 登録は boot より**後**(帯域を奪い合わせない)', () => {
    const body = bootstrapBody();
    expect(body.indexOf('registerSw()')).toBeGreaterThan(body.indexOf('startApp(root)'));
  });

  /**
   * ⚠ **順序の検査は「両方が在ること」を先に見る**。`indexOf` は無いと `-1` を
   * 返すので、**片方を消すと `-1 < N` で素通りする** ── 実際に変異試験で
   * 「ready の印を消す」変異が生き残った(検査する側も変異の対象、CLAUDE.md)。
   */
  const orderedIn = (body: string, first: string, second: string): void => {
    const a = body.indexOf(first);
    const b = body.indexOf(second);
    expect(a, `${first} が無い`).toBeGreaterThan(-1);
    expect(b, `${second} が無い`).toBeGreaterThan(-1);
    expect(a, `${first} が ${second} より後ろにある`).toBeLessThan(b);
  };

  it('🔴 更新の見張りは boot が ready になってから張る', () => {
    // 案内の面は shell が無いと出せない ── 早く張ると `presentUpdate` が空を叩く
    orderedIn(bootstrapBody(), "'data-pkc-boot', 'ready'", 'watchForUpdate(');
  });

  it('🔴 `launchQueue` の受け口も boot が解決してから張る(段③)', () => {
    // 仕様上 LaunchParams は consume されるまで無期限にバッファされる ──
    // 早く張って自前バッファへ吸い出すと、取りこぼしの責任がアプリへ移る
    orderedIn(bootstrapBody(), '.then((app)', 'armLaunchQueue(');
  });

  it('🔴 boot 前の交代の見張りは **`startApp` より前**に張る(段⑧)', () => {
    // lease 待ちで止まっている窓こそが対象なので、boot の解決を待っては意味がない
    orderedIn(bootstrapBody(), 'reloadOnPrebootSwap(', 'startApp(root)');
  });

  it('🔴 boot が終わったら**成功側・失敗側の両方**で見張りを畳む(段⑧)', () => {
    // ⚠ 失敗側で畳まないと、更新のたびに **error 画面が勝手に読み直されて**
    // 理由が消える ── user は何が起きたか分からないまま同じ画面を見続ける
    const body = bootstrapBody();
    expect([...body.matchAll(/preboot\?\.booted\(\)/g)].length).toBe(2);
    const thenAt = body.indexOf('.then((app)');
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(body.slice(thenAt, catchAt)).toContain('preboot?.booted()');
    expect(body.slice(catchAt)).toContain('preboot?.booted()');
  });

  it('boot 失敗を白画面にしない(理由を出す)', () => {
    expect(bootstrapBody()).toContain("'data-pkc-boot', 'error'");
    expect(bootstrapBody()).toContain('起動に失敗しました');
  });
});

/**
 * 🔴 **boot が失敗したときの後始末**(2026-08-06。user 報告 2-14)。
 *
 * ⚠ ここも原文の検査である ── `bootstrap()` は node から呼べない。だが
 * 「誰も見ていない」で済ませると、**この 2 行を消す変異が全緑で通る**
 * (実際、直す前は `release()` の呼び出しが src に **0 件**だった)。
 */
describe('boot 失敗の後始末', () => {
  it('🔴 握った書込 lease を返す(他のタブを永久に待たせない)', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(catchAt).toBeGreaterThan(-1);
    expect(
      body.slice(catchAt),
      'boot 失敗で lease を返していない ── このタブが開いている間、他のタブは' +
        '「別のタブで開いています」から進めない',
    ).toContain('bootLease?.release()');
    // ⚠ 成功側では返さない(握り続けるのが正しい)
    const thenAt = body.indexOf('.then((app)');
    expect(body.slice(thenAt, catchAt)).not.toContain('release()');
  });

  it('🔴 `release()` の呼び出しが src に実在する(0 件に戻っていない)', () => {
    // 直す前はここが 0 件だった ── 型が通るので tsc も lint も黙る
    expect(
      [...MAIN.matchAll(/bootLease\?\.release\(\)/g)].length,
      'lease を返す呼び出しが消えている',
    ).toBeGreaterThan(0);
  });

  it('🔴 OS から渡されたファイルが消えていないことを伝える', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    const tail = body.slice(catchAt);
    // 受け口は成功側にしか張らない(= 消えていない)ので、**そう言う**
    expect(tail, 'ファイルの行方を伝えていない').toContain('launchQueue');
    expect(tail).toContain('読み直すと開きます');
  });

  it('⚠ 受け口(launchQueue)は失敗側では張らない(consume すると本当に消える)', () => {
    const body = bootstrapBody();
    const catchAt = body.indexOf('.catch((e: unknown)');
    expect(
      body.slice(catchAt),
      '失敗側で受け口を張っている ── consume した時点でファイルは戻らない',
    ).not.toContain('armLaunchQueue(');
  });
});
