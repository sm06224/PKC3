/** @vitest-environment node */
/**
 * 🔴 **重い正規表現の置換で画面が固まらない**(テキスト整形のレビュー ⚠1。**実物の別スレッドで**見る)。
 *
 * ⚠ 偽のワーカーでは「固まる」を再現できない(偽は呼び出し元と同じスレッドで走る)。ここでは
 *   本物のワーカー(`platform/text/lab-worker.ts` を束ねたもの)を Node の別スレッドで動かし、
 *   本物の `terminate()` が効くことを、**メインスレッドの時計が止まらない**ことで確かめる。
 * 🔑 入力は 27 字の `(a+)+$`(`aaaa…ab` に当てると、入れ子の繰り返しが指数的に戻って何秒も終わらない)。
 *   メインスレッドで直に回すと、その間ずっと画面が止まる ── それが直す前の姿である。
 *
 * 守る主張:
 * 1. 重い式は時間切れで止まり、「重すぎるので止めました」と入力のままの結果を返す(固まらない)
 * 2. 止めている間もメインスレッドの時計は進む(最大の遅れが小さい)
 * 3. 止めたワーカーは本当に終わっている(CPU を使い続けない)
 * 4. そのあとの軽い置換は、黙って作り直されたワーカーで普通に動く
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker as NodeWorker } from 'node:worker_threads';
import { rolldown } from 'rolldown';
import { resolve } from 'node:path';
import {
  LAB_REGEX_TIMEOUT_NOTE,
  LabRegexClient,
} from '../../src/adapter/platform/text/lab-client';

const ROOT = resolve(__dirname, '../..');

let bundle = '';

beforeAll(async () => {
  const b = await rolldown({
    input: resolve(ROOT, 'src/adapter/platform/text/lab-worker.ts'),
    resolve: { alias: { '@features': resolve(ROOT, 'src/features') } },
    logLevel: 'silent',
  });
  const { output } = await b.generate({ format: 'iife' });
  bundle = output[0].code;
  await b.close();
}, 60_000);

/** Web Worker の形をした Node スレッド。 */
class ThreadWorker {
  static made: ThreadWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly exited: Promise<number>;
  private readonly w: NodeWorker;
  constructor() {
    const prelude = `const { parentPort } = require('node:worker_threads');
globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };
parentPort.on('message', (d) => { if (self.onmessage) self.onmessage({ data: d }); });
`;
    this.w = new NodeWorker(prelude + bundle, { eval: true });
    this.w.on('message', (d) => this.onmessage?.({ data: d }));
    this.w.on('error', (e) => this.onerror?.({ message: String(e) }));
    this.exited = new Promise((r) => this.w.on('exit', r));
    ThreadWorker.made.push(this);
  }
  postMessage(msg: unknown): void {
    this.w.postMessage(msg);
  }
  terminate(): void {
    void this.w.terminate();
  }
}

afterAll(async () => {
  for (const w of ThreadWorker.made) w.terminate();
  await Promise.all(ThreadWorker.made.map((w) => w.exited));
});

/** 事件ループの遅れの最大値(ms)を測る。固まっていれば大きくなる。 */
function lagMeter() {
  let last = performance.now();
  let max = 0;
  const h = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 20);
    last = now;
  }, 20);
  return {
    stop: (): number => {
      clearInterval(h);
      return max;
    },
  };
}

describe('重い正規表現の置換(本物の別スレッド)', () => {
  it('🔴 27 字の (a+)+$ は時間切れで止まり、メインスレッドの時計は止まらず、ワーカーは本当に終わる', async () => {
    ThreadWorker.made = [];
    const client = new LabRegexClient({ spawn: () => new ThreadWorker() as unknown as Worker, timeoutMs: 400 });
    const input = `${'a'.repeat(26)}b`;
    expect(input).toHaveLength(27);
    const meter = lagMeter();
    const t0 = performance.now();
    const got = await client.apply(input, { pattern: '(a+)+$', replacement: 'x', flags: '' });
    const elapsed = performance.now() - t0;
    const lag = meter.stop();
    // 1. 止めて、理由を言い、入力はそのまま
    expect(got.note, '重い置換を止めたと言っていない(終わるまで待った?)').toBe(LAB_REGEX_TIMEOUT_NOTE);
    expect(got.text, '止めたのに結果が変わっている').toBe(input);
    expect(got.hits).toBe(0);
    // 2. 時間切れで返った(重い式が終わるのを待っていない)
    expect(elapsed, '時間切れで切れていない').toBeLessThan(1700);
    // 3. メインスレッドは止まらなかった(直に回すと 1.5 秒以上止まる)
    // ⚠ 直に回すと 1.9 秒以上止まる式。他の処理で CPU が混む環境でも誤って鳴らないよう、しきい値はその半分より下に置く
    expect(lag, `メインスレッドが ${Math.round(lag)}ms 止まった`).toBeLessThan(800);
    // 4. 止めたワーカーは本当に終わっている
    expect(ThreadWorker.made).toHaveLength(1);
    const code = await Promise.race([
      ThreadWorker.made[0]!.exited,
      new Promise<string>((r) => setTimeout(() => r('not-exited'), 3000)),
    ]);
    expect(code, '止めたはずのワーカーが終わっていない(CPU を使い続ける)').not.toBe('not-exited');
    expect(client.alive).toBe(false);
  }, 20_000);

  it('🔴 止めたあとの軽い置換は、作り直されたワーカーで普通に動く(置換の数も数える)', async () => {
    ThreadWorker.made = [];
    // ⚠ 作り直したワーカーの起動(スレッド + 束の評価)は、負荷のある環境で数百 ms かかる ── 時間切れは余裕を持たせる。
    //   重い式は 30 字(手元で十数秒)にして、余裕のある時間切れでも確実に止まる側に置く
    const client = new LabRegexClient({ spawn: () => new ThreadWorker() as unknown as Worker, timeoutMs: 2500 });
    const heavy = await client.apply(`${'a'.repeat(29)}b`, { pattern: '(a+)+$', replacement: 'x', flags: '' });
    expect(heavy.note).toBe(LAB_REGEX_TIMEOUT_NOTE);
    const light = await client.apply('abc 123 def 45', { pattern: '\\d+', replacement: '<$&>', flags: 'g' });
    expect(light.note).toBeNull();
    expect(light.text).toBe('abc <123> def <45>');
    expect(light.hits).toBe(2);
    expect(ThreadWorker.made, '作り直していない').toHaveLength(2);
    client.dispose();
  }, 40_000);

  it('⚠ 対照群 ── 軽い式なら時間切れにならず、そのまま結果を返す', async () => {
    ThreadWorker.made = [];
    // 起動に時間がかかる環境でも切れないよう、時間切れは長くする(軽い式が時間切れで負けないことを見る対照群)
    const client = new LabRegexClient({ spawn: () => new ThreadWorker() as unknown as Worker, timeoutMs: 10_000 });
    const r = await client.apply('aaa', { pattern: 'a+', replacement: 'x', flags: '' });
    expect(r).toEqual({ text: 'x', note: null, hits: 1 });
    client.dispose();
  }, 20_000);
});
