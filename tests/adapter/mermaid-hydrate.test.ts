/** @vitest-environment happy-dom */
/**
 * P8 段⑪: **図の面倒を見る根を、まとめて受ける**。
 *
 * 🔴 差分反映は「新しく入った要素」を**何個も**渡してくる。1 個ずつ呼ぶと
 *  - 要素の数だけ観測器(IntersectionObserver)と先読みループができる
 *  - **2 個目以降の根にある図が拾われない**実装でも、1 個だけの test なら緑になる
 *
 * ⚠ 観測点は「描けたか」ではなく「**観測を始めたか**」── 実際の焼き上げは
 * mermaid の読み込みが要るので、ここでは配線だけを見る。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { hydrateMermaid } from '../../src/adapter/ui/render/mermaid-hydrate';
import { renderToPng } from '../../src/adapter/ui/render/mermaid-raster';

// 🔑 焼く所は差す ── ここで見たいのは**いつ焼き直すか**であって、絵ではない
vi.mock('../../src/adapter/ui/render/mermaid-raster', () => ({
  renderToPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  readPalette: () => ({
    bg: '#fff',
    alt: '#eee',
    fg: '#000',
    line: '#666',
    border: '#ccc',
    accent: '#080',
    dark: false,
  }),
}));

const observed: Element[] = [];
let disconnected = 0;
/** 器 → 「見えた」を起こす手。 */
let fire: ((els: Element[]) => void) | null = null;

class FakeIO {
  constructor(cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    fire = (els) => cb(els.map((target) => ({ target, isIntersecting: true })));
  }
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnected += 1;
  }
}

beforeEach(() => {
  observed.length = 0;
  disconnected = 0;
  fire = null;
  vi.mocked(renderToPng).mockClear();
  document.documentElement.setAttribute('data-pkc-theme', 'light');
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 器 1 個を含む塊(実際の markup と同じ入れ子)。 */
function block(src: string): HTMLElement {
  const outer = document.createElement('div');
  outer.className = 'pkc-md-block';
  const slot = document.createElement('div');
  slot.className = 'pkc-render-slot';
  const host = document.createElement('div');
  host.setAttribute('data-pkc-mermaid-src', src);
  slot.append(host);
  outer.append(slot);
  return outer;
}

describe('図の hydrate', () => {
  it('1 つの根の中の器を観測する', () => {
    const dispose = hydrateMermaid(block('graph TD\n A-->B'));
    expect(observed).toHaveLength(1);
    dispose();
    expect(disconnected).toBe(1);
  });

  it('🔴 **複数の根**を渡したら全部の器を観測する', () => {
    // ⚠ ここが本丸 ── 先頭の根しか見ない実装だと、差分で入った 2 個目以降の図が
    // **永久に描かれない**(白いままで、例外も出ない)
    const plain = document.createElement('p');
    const dispose = hydrateMermaid([plain, block('a'), block('b')]);
    expect(observed, '2 個目以降の根にある図を拾っていない').toHaveLength(2);
    // ⚠ 観測器は**1 本**(根の数だけ作らない)
    dispose();
    expect(disconnected).toBe(1);
  });

  it('⚠ 根そのものが器でも拾う(`querySelectorAll` は自分を含まない)', () => {
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', 'x');
    // ⚠ 畳む ── 畳み忘れると**配色の観測器がこの file に残り**、後続の test が
    //    「観測器が新しく作られない」を誤って観測する(実際に踏んだ)
    hydrateMermaid([host])();
    expect(observed).toHaveLength(1);
  });

  it('図が無ければ観測器を作らない(空の後始末が返る)', () => {
    const dispose = hydrateMermaid([document.createElement('p')]);
    expect(observed).toHaveLength(0);
    dispose();
    expect(disconnected, '器が無いのに観測器を作った').toBe(0);
  });
});

/**
 * P8 段⑬: 🔴 **配色を変えたら焼き直す**。
 *
 * 🔴 直す前の実測(preview ビルド):ダークにしても `<img src>` が変わらず、
 * 平均輝度 231.2 のまま ── `docs/manual.md` の「配色を変えると焼き直します」は
 * 嘘だった。鍵にテーマが入っていても、**焼き直しを起こす者がいなかった**。
 *
 * ⚠ 観測点は「`<img>` が在るか」ではなく「**焼く関数が呼び直されたか**」と
 * 「**前の URL を返したか**」── 下流の見た目だけ見ると、たまたま同じ絵でも通る。
 */
describe('配色を変えたときの焼き直し(P8 段⑬)', () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:m${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** MutationObserver は非同期に届く ── 届くまで待つ。 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('🔴 配色を変えると、**焼いた器だけ**焼き直る', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const dispose = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);
    expect(b.querySelector('[data-pkc-field="mermaid-image"]')).not.toBeNull();
    const first = vi.mocked(renderToPng).mock.calls[0]![0].theme;

    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng), '配色を変えても焼き直していない').toHaveBeenCalledTimes(2);
    const second = vi.mocked(renderToPng).mock.calls[1]![0].theme;
    // ⚠ **新しい配色で**焼いている(呼び直しただけで前の色を渡すと意味がない)
    expect(first).toBe('light');
    expect(second).toBe('dark');
    // ⚠ 前の URL は返す(焼き直すたびに ObjectURL が積もらない)
    expect(revoked).toEqual([created[0]]);

    dispose();
    b.remove();
  });

  it('🔴 まだ焼いていない器は、配色を変えても**先回りして焼かない**', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const dispose = hydrateMermaid(b);
    // `fire` を呼ばない = まだ見えていない
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(0);
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng), '見えていない図を先回りで焼いた').toHaveBeenCalledTimes(0);
    dispose();
    b.remove();
  });

  it('🔴 畳んだ後は焼き直さない(外した面のために働かない)', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const dispose = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);

    dispose();
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng), '畳んだ後も焼き直している').toHaveBeenCalledTimes(1);
    // ⚠ 畳んだ時点で URL は返っている(表示の寿命終端 ── 2026-07-27 不可侵指示)
    expect(revoked).toEqual([created[0]]);
    b.remove();
  });

  it('⚠ DOM から外れた器は焼き直さない(detached へ描かない)', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const dispose = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    b.remove(); // 器ごと DOM から外れる(dispose はまだ)
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);
    dispose();
  });
});

/**
 * P8 段⑬: **配色の観測器そのものの寿命**。
 *
 * 🔴 変異試験で `unwatchTheme()` を消しても緑だった ── 焼き直しは `disposed`
 * ガードが止めるので、**「畳んだ後に焼き直さない」test では死なない**。
 * 救い手が別に居るのに、観測点をそこへ置いていた(この repo の規律:
 * 「空振りを直したら、今度は何に救われていないかを問う」)。
 *
 * 消えていた本当の被害は **観測器と購読の残留**:`hydrateMermaid` は差分反映の
 * たびに呼ばれるので、外れない購読は塊の数だけ積もる。だから観測点は
 * **`MutationObserver` を作った / 畳んだ回数**にする。
 *
 * ⚠ 「属性が変わったら実際に焼き直る」端は、上の 4 件(本物の MutationObserver)と
 * `tests/smoke/mermaid.smoke.spec.ts`(実画素)が見る ── **両端に置く**。
 */
describe('配色の観測器の寿命(P8 段⑬)', () => {
  let made = 0;
  let closed = 0;
  const targets: { el: unknown; opts: MutationObserverInit | undefined }[] = [];

  class FakeMO {
    constructor(_cb: unknown) {
      void _cb;
      made += 1;
    }
    observe(el: Node, opts?: MutationObserverInit): void {
      targets.push({ el, opts });
    }
    disconnect(): void {
      closed += 1;
    }
    takeRecords(): [] {
      return [];
    }
  }

  beforeEach(() => {
    made = 0;
    closed = 0;
    targets.length = 0;
    vi.stubGlobal('MutationObserver', FakeMO);
  });

  it('⚠ 配色の属性だけを、`<html>` で見る(全 DOM を観測しない)', () => {
    const dispose = hydrateMermaid(block('a'));
    expect(made).toBe(1);
    expect(targets[0]!.el).toBe(document.documentElement);
    expect(targets[0]!.opts?.attributeFilter).toEqual(['data-pkc-theme']);
    expect(targets[0]!.opts?.attributes).toBe(true);
    dispose();
  });

  it('🔴 全部畳んだら観測を止める(外した面のために回り続けない)', () => {
    const d1 = hydrateMermaid(block('a'));
    const d2 = hydrateMermaid(block('b'));
    d1();
    expect(closed, 'まだ見ている塊があるのに観測を止めた').toBe(0);
    d2();
    expect(closed, '誰も見ていないのに観測器が回り続けている').toBe(1);
  });

  it('🔴 何回 hydrate しても観測器は **1 つ**(塊の数だけ作らない)', () => {
    const ds = [block('a'), block('b'), block('c'), block('d')].map((b) => hydrateMermaid(b));
    expect(made, '塊の数だけ観測器を作っている').toBe(1);
    for (const d of ds) d();
    expect(closed).toBe(1);
    // ⚠ 畳んだ後にまた使えること(1 度きりの機構にしない)
    const again = hydrateMermaid(block('e'));
    expect(made).toBe(2);
    again();
  });
});
