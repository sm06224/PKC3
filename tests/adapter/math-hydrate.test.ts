/** @vitest-environment happy-dom */
/**
 * 🔴 **数式の器を埋める配線**(#707)。
 *
 * ⚠ **「ワーカーの中だから unit では届かない」は誤りである**(CLAUDE.md §2)──
 *   `setMathWorkerSpawn` は test のために開けてある口で、着地前レビューまで
 *   **誰も使っていなかった**。そのせいで、次の 3 つが全部素通りしていた:
 *   ①結果を**逆順**に当てる ②`display` を**いつも false** で渡す
 *   ③`prune()` を **`return 0`** にする(docstring が名指しで戒めている当の変異)。
 *
 * ⚠ 実ブラウザでしか見られないのは「**本当に数式の形に組めるか**」だけである
 *   ── そちらは `tests/smoke/math.smoke.spec.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hydrateMath, setMathWorkerSpawn } from '../../src/adapter/ui/render/math-hydrate';
import type { MathJob, MathResult } from '../../src/adapter/platform/render/math-worker';

/** 受けた依頼を控えて、こちらの好きな結果を返す偽のワーカー。 */
class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  static seen: MathJob[] = [];
  /** 何を返すか(既定は「式をそのまま囲んだ HTML」)。 */
  static reply: (job: MathJob) => MathResult[] = (job) =>
    job.items.map((it) => ({ ok: true, html: `<k d="${it.display ? '1' : '0'}">${it.tex}</k>` }));

  postMessage(msg: { id: number; payload: MathJob }): void {
    FakeWorker.seen.push(msg.payload);
    const result = FakeWorker.reply(msg.payload);
    // ⚠ 本物と同じく**非同期**で返す(同期に返すと待ちの穴を見られない)
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result } } as MessageEvent));
  }
  terminate(): void {}
}

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const host = (tex: string, display: boolean): string =>
  `<span data-pkc-math-src="${tex}" data-pkc-math-display="${display ? '1' : '0'}">$${tex}$</span>`;

afterEach(() => {
  setMathWorkerSpawn(null);
  FakeWorker.seen = [];
  FakeWorker.reply = (job) =>
    job.items.map((it) => ({ ok: true, html: `<k d="${it.display ? '1' : '0'}">${it.tex}</k>` }));
  document.body.textContent = '';
});

/** 流し込みが終わるまで待つ(空き時間の分割があるので何度か回す)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('数式の器を埋める(#707)', () => {
  it('🔴 器の順番どおりに結果を当てる(入れ替わらない)', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    const root = mount(`<p>${host('AAA', false)} と ${host('BBB', false)}</p>`);
    hydrateMath(root);
    await settle();
    const got = [...root.querySelectorAll('[data-pkc-math-src]')].map((e) => e.textContent);
    // 🔴 逆順に当てる変異は、ここでしか死なない(smoke は数しか見ていない)
    expect(got, '結果が入れ替わって当たっている').toEqual(['AAA', 'BBB']);
  });

  it('🔴 塊かどうかをワーカーへ渡す(いつも行の中にしない)', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    const root = mount(`<p>${host('a', false)}</p>${host('b', true)}`);
    hydrateMath(root);
    await settle();
    expect(FakeWorker.seen.length, '依頼が飛んでいない(空振り)').toBe(1);
    expect(
      FakeWorker.seen[0]!.items.map((i) => i.display),
      '塊の印がワーカーへ渡っていない(中央寄せの式が行の中の組みになる)',
    ).toEqual([false, true]);
  });

  it('🔴 描けなかった器は、打った字がそのまま残る', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    FakeWorker.reply = () => [{ ok: false, error: '式が読めません' }];
    const root = mount(`<p>${host('bad^^', false)}</p>`);
    hydrateMath(root);
    await settle();
    const el = root.querySelector('[data-pkc-math-src]')!;
    // 🔑 打った字は**捨てない**(直す手がかりである)
    expect(el.firstChild?.textContent, '打った字が捨てられた').toBe('$bad^^$');
    expect(el.getAttribute('data-pkc-math-state'), '失敗の印が付いていない').toBe('failed');
    expect(el.getAttribute('data-pkc-math-error'), '理由が残っていない').toContain('読めません');
    /**
     * 🔴 **画面にも 1 つ出す**(user 裁定 2026-09-06)── 打った字が残るだけだと、
     *   「数式のつもりが読めなかった」のか「そもそも数式として読まれていない」
     *   (金額 / 差し込み / 逆引用符の中)のかが user から区別できない。
     */
    const note = el.querySelector('.pkc-math-error');
    expect(note?.textContent, '読めなかった断りが画面に出ていない').toBe('式が読めません');
    // ⚠ KaTeX の英語のエラーは画面に出さない(属性にだけ残す)
    expect(el.textContent, '英語のエラーが画面に出ている').not.toContain('KaTeX');
  });

  it('⚠ 描き直しても、断りは 1 つだけ', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    FakeWorker.reply = () => [{ ok: false, error: 'x' }];
    const root = mount(`<p>${host('bad', false)}</p>`);
    hydrateMath(root);
    await settle();
    const el = root.querySelector<HTMLElement>('[data-pkc-math-src]')!;
    // ⚠ 印を外して、もう一度通す(器を作り直す経路を真似る)
    el.removeAttribute('data-pkc-math-state');
    hydrateMath(root);
    await settle();
    expect(
      el.querySelectorAll('.pkc-math-error').length,
      '断りが二重に付いた',
    ).toBe(1);
  });

  /**
   * 🔴 **ワーカーが立たないときは、画面に断りを出さない**(user 裁定の含意)。
   * ⚠ それは**式のせいではない**(user には直しようが無い)── 「式が読めません」と
   *   出すと、正しい式を書いた人に嘘をつくことになる。
   */
  it('🔴 ワーカーが立たないときは「式が読めません」と言わない', async () => {
    setMathWorkerSpawn(() => {
      throw new Error('起動できない');
    });
    const root = mount(`<p>${host('a', false)}</p>`);
    hydrateMath(root);
    await settle();
    const el = root.querySelector('[data-pkc-math-src]')!;
    expect(el.getAttribute('data-pkc-math-state'), '失敗の印が付いていない(空振り)').toBe('failed');
    expect(
      el.querySelector('.pkc-math-error'),
      '式のせいではないのに「式が読めません」と出している',
    ).toBeNull();
    expect(el.textContent, '打った字が消えた').toBe('$a$');
  });

  it('⚠ 結果が足りなくても、その器だけが失敗になる', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    FakeWorker.reply = () => [{ ok: true, html: '<k>a</k>' }];
    const root = mount(`<p>${host('a', false)} ${host('b', false)}</p>`);
    hydrateMath(root);
    await settle();
    const els = [...root.querySelectorAll('[data-pkc-math-src]')];
    expect(els[0]!.getAttribute('data-pkc-math-state'), '1 つ目が埋まっていない').toBe('done');
    expect(els[1]!.getAttribute('data-pkc-math-state'), '2 つ目が失敗になっていない').toBe('failed');
  });

  /**
   * 🔴 **描き終わる前に畳ませない**(`math-hydrate.ts` の `prune` の docstring)。
   * ⚠ `pruneScopes` は `prune() === 0` で `dispose()` するので、`return 0` にすると
   *   **結果が捨てられる**(画面は打った字のまま、印も付かない)。
   */
  it('🔴 埋め終わるまで prune() は 0 を返さない', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    const root = mount(`<p>${host('a', false)}</p>`);
    const scope = hydrateMath(root);
    expect(scope.prune(), '投げた直後にもう畳んでよいと言っている').toBeGreaterThan(0);
    await settle();
    expect(scope.prune(), '埋め終わっても畳めないと言っている').toBe(0);
  });

  it('⚠ 器が DOM から外れていたら、もう要らないと言う', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    const root = mount(`<p>${host('a', false)}</p>`);
    const scope = hydrateMath(root);
    root.remove();
    expect(scope.prune(), '外れた器の結果をまだ待っている').toBe(0);
  });

  it('⚠ 数式が 1 つも無ければワーカーを起こさない', async () => {
    let spawned = 0;
    setMathWorkerSpawn(() => {
      spawned += 1;
      return new FakeWorker() as unknown as Worker;
    });
    hydrateMath(mount('<p>ただの本文</p>'));
    await settle();
    expect(spawned, '数式が無いのにワーカーを起こした').toBe(0);
  });

  it('⚠ 一度埋めた器は、描き直しても二度と拾わない', async () => {
    setMathWorkerSpawn(() => new FakeWorker() as unknown as Worker);
    const root = mount(`<p>${host('a', false)}</p>`);
    hydrateMath(root);
    await settle();
    hydrateMath(root);
    await settle();
    expect(FakeWorker.seen.length, '埋め済みの器をもう一度投げている').toBe(1);
  });
});
