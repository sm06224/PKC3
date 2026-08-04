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
import { hydrateMermaid, type MermaidScope } from '../../src/adapter/ui/render/mermaid-hydrate';
import { renderToPng } from '../../src/adapter/ui/render/mermaid-raster';

// 🔑 焼く所は差す ── ここで見たいのは**いつ焼き直すか**であって、絵ではない。
// ⚠ `cacheKey` は**本物を通す**(段㉘)── 焼き直しの要否は鍵の一致で決めるので、
//    ここを偽物にすると「鍵が同じなら焼かない」という当の振る舞いを test 側が
//    決めてしまう(stub が実装より正しいとバグが隠れる、という規律)。
vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    cacheKey: real.cacheKey,
    renderToPng: vi.fn(async () => ({
      png: new Blob(['png'], { type: 'image/png' }),
      cssWidth: 320,
    })),
    readPalette: () => ({
      bg: '#fff',
      alt: '#eee',
      fg: '#000',
      line: '#666',
      border: '#ccc',
      accent: '#080',
      dark: false,
    }),
  };
});

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

/** 器の親を観る `ResizeObserver`(段㉘)。「幅が変わった」を起こす手を持つ。 */
const roObserved: Element[] = [];
let roDisconnected = 0;
let fireResize: (() => void) | null = null;
class FakeRO {
  constructor(cb: () => void) {
    fireResize = cb;
  }
  observe(el: Element): void {
    roObserved.push(el);
  }
  disconnect(): void {
    roDisconnected += 1;
  }
}

/** dpr の問い(段㉘)。外れたことを起こす手を持つ。 */
let fireDpr: (() => void) | null = null;
let mqRemoved = 0;
function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q,
    matches: true,
    addEventListener: (_t: string, cb: () => void) => {
      fireDpr = cb;
    },
    removeEventListener: () => {
      mqRemoved += 1;
    },
  }));
}

/** 器の親の見かけの幅を決める(happy-dom は実レイアウトを持たない)。 */
function setPaneWidth(host: Element, px: number): void {
  Object.defineProperty(host.parentElement!, 'clientWidth', {
    value: px,
    configurable: true,
  });
}

beforeEach(() => {
  observed.length = 0;
  disconnected = 0;
  fire = null;
  roObserved.length = 0;
  roDisconnected = 0;
  fireResize = null;
  fireDpr = null;
  mqRemoved = 0;
  vi.mocked(renderToPng).mockClear();
  document.documentElement.setAttribute('data-pkc-theme', 'light');
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.stubGlobal('devicePixelRatio', 1);
  installMatchMedia();
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
    const scope = hydrateMermaid(block('graph TD\n A-->B'));
    expect(observed).toHaveLength(1);
    scope.dispose();
    expect(disconnected).toBe(1);
  });

  it('🔴 **複数の根**を渡したら全部の器を観測する', () => {
    // ⚠ ここが本丸 ── 先頭の根しか見ない実装だと、差分で入った 2 個目以降の図が
    // **永久に描かれない**(白いままで、例外も出ない)
    const plain = document.createElement('p');
    const scope = hydrateMermaid([plain, block('a'), block('b')]);
    expect(observed, '2 個目以降の根にある図を拾っていない').toHaveLength(2);
    // ⚠ 観測器は**1 本**(根の数だけ作らない)
    scope.dispose();
    expect(disconnected).toBe(1);
  });

  it('⚠ 根そのものが器でも拾う(`querySelectorAll` は自分を含まない)', () => {
    const host = document.createElement('div');
    host.setAttribute('data-pkc-mermaid-src', 'x');
    // ⚠ 畳む ── 畳み忘れると**配色の観測器がこの file に残り**、後続の test が
    //    「観測器が新しく作られない」を誤って観測する(実際に踏んだ)
    hydrateMermaid([host]).dispose();
    expect(observed).toHaveLength(1);
  });

  it('図が無ければ観測器を作らない(空の後始末が返る)', () => {
    const scope = hydrateMermaid([document.createElement('p')]);
    expect(observed).toHaveLength(0);
    scope.dispose();
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
    const scope = hydrateMermaid(b);
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

    scope.dispose();
    b.remove();
  });

  it('🔴 まだ焼いていない器は、配色を変えても**先回りして焼かない**', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const scope = hydrateMermaid(b);
    // `fire` を呼ばない = まだ見えていない
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(0);
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng), '見えていない図を先回りで焼いた').toHaveBeenCalledTimes(0);
    scope.dispose();
    b.remove();
  });

  it('🔴 畳んだ後は焼き直さない(外した面のために働かない)', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);

    scope.dispose();
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
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    b.remove(); // 器ごと DOM から外れる(dispose はまだ)
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);
    scope.dispose();
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
    const scope = hydrateMermaid(block('a'));
    expect(made).toBe(1);
    expect(targets[0]!.el).toBe(document.documentElement);
    expect(targets[0]!.opts?.attributeFilter).toEqual(['data-pkc-theme']);
    expect(targets[0]!.opts?.attributes).toBe(true);
    scope.dispose();
  });

  it('🔴 全部畳んだら観測を止める(外した面のために回り続けない)', () => {
    const d1 = hydrateMermaid(block('a'));
    const d2 = hydrateMermaid(block('b'));
    d1.dispose();
    expect(closed, 'まだ見ている塊があるのに観測を止めた').toBe(0);
    d2.dispose();
    expect(closed, '誰も見ていないのに観測器が回り続けている').toBe(1);
  });

  it('🔴 何回 hydrate しても観測器は **1 つ**(塊の数だけ作らない)', () => {
    const ds = [block('a'), block('b'), block('c'), block('d')].map((b) => hydrateMermaid(b));
    expect(made, '塊の数だけ観測器を作っている').toBe(1);
    for (const d of ds) d.dispose();
    expect(closed).toBe(1);
    // ⚠ 畳んだ後にまた使えること(1 度きりの機構にしない)
    const again = hydrateMermaid(block('e'));
    expect(made).toBe(2);
    again.dispose();
  });
});

/**
 * P8 段⑰: 🔴 **塊を積もらせない / 古い配色を最後に勝たせない**(レビュー H-5 / H-8)。
 *
 * 🔴 直す前の実測:
 * - 器を差し替えながら 5 回 `hydrateMermaid` を呼ぶ(= 編集プレビューの静穏 tick
 *   5 回)と `createObjectURL` 5 回 / `revokeObjectURL` **0 回** ── 画面に無い
 *   PNG の URL が 4 本、編集を抜けるまで生きたままだった
 * - 配色を続けて変えると、**最後に解決した**古い配色の絵が残った(焼くのは非同期で、
 *   後から始まった方が先に終わりうる)
 */
describe('塊の畳み方と焼き直しの世代(P8 段⑰)', () => {
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:p${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('🔴 器が外れた塊は `prune()` で 0 になり、URL が返る', async () => {
    const host = document.createElement('div');
    host.className = 'wrap';
    document.body.append(host);
    const b = block('graph TD\n A-->B');
    host.append(b);

    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(created).toHaveLength(1);
    // まだ画面に居るので畳まない
    expect(scope.prune(), '生きている器を畳んでしまった').toBe(1);
    expect(revoked).toEqual([]);

    // 差分反映が器ごと差し替えた(古い器は detached)
    b.remove();
    expect(scope.prune(), '外れた器が残っている').toBe(0);
    expect(revoked, '外れた器の URL を返していない').toEqual([created[0]]);
    scope.dispose();
    host.remove();
  });

  it('⚠ `prune()` は二重に返さない(dispose と重ねても壊れない)', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    b.remove();
    scope.prune();
    scope.prune();
    scope.dispose();
    expect(revoked, '同じ URL を 2 回返している').toEqual([created[0]]);
  });

  it('🔴 焼いている間に配色が変わったら、その結果は**載せない**', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);

    // 焼くのを止めたまま配色を 2 回変える
    const held: Array<(v: { png: Blob; cssWidth: number }) => void> = [];
    vi.mocked(renderToPng).mockImplementationOnce(
      () => new Promise((res) => held.push(res)),
    );
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    const madeBefore = created.length;
    document.documentElement.setAttribute('data-pkc-theme', 'nord');
    await settle();
    // 止めていた 1 枚目(dark)を今ごろ返す ── **載ってはいけない**
    held[0]?.({ png: new Blob(['png']), cssWidth: 320 });
    await settle();
    expect(
      created.length - madeBefore,
      '古い配色の結果が最後に勝って画面へ載った',
    ).toBeLessThanOrEqual(1);
    scope.dispose();
    b.remove();
  });

  it('🔴 **焼いている最中**の器も、配色が変わったら焼き直す', async () => {
    // ⚠ 焼き終わったもの(`urlOf`)だけを対象にすると、ちょうど焼いている 1 枚が
    //    古い配色のまま残る ── 対象は**焼き始めた器**
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const held: Array<(v: { png: Blob; cssWidth: number }) => void> = [];
    vi.mocked(renderToPng).mockImplementationOnce(
      () => new Promise((res) => held.push(res)),
    );
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1); // まだ返っていない

    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    await settle();
    // 🔴 ここが本丸 ── 完了していなくても焼き直しが走る
    expect(
      vi.mocked(renderToPng),
      '焼いている最中の器が古い配色のまま置き去りになる',
    ).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderToPng).mock.calls[1]![0].theme).toBe('dark');
    held[0]?.({ png: new Blob(['png']), cssWidth: 320 });
    await settle();
    scope.dispose();
    b.remove();
  });

  it('⚠ DOM から外れた器は最初から焼かない(先読み列が差し替え済みを焼き続けない)', async () => {
    const b = block('graph TD\n A-->B');
    // ⚠ **append しない**(= 最初から detached)
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    expect(vi.mocked(renderToPng), '画面に無い器を焼いた').toHaveBeenCalledTimes(0);
    scope.dispose();
  });
});

/**
 * P8 段㉘: 🔴 **幅と dpr が変わったら焼き直す**。
 *
 * 🔴 段⑬ は配色について「鍵はあるが焼き直しを起こす者がいない」を直したが、
 * **同じ穴が幅と dpr に残っていた**。実測(preview ビルドを実ブラウザで):
 *
 * | | 器の幅 | PNG 実寸 | dpr |
 * |---|---|---|---|
 * | 初期 | 685px | 688 × 28 | 1 |
 * | 幅を広げた | 974px | **688 × 28**(そのまま) | 1 |
 * | dpr を 3 に | 974px | **688 × 28**(そのまま) | 3 |
 * | 塊を作り直した | 974px | 2928 × 122 | 3 |
 *
 * ── ズームすると**周りの文字だけ鮮明になって図はぼける**。ペイン幅を広げても
 * 図は小さいまま。塊を作り直せば直るので、**鍵は正しく、引き金だけが無かった**。
 *
 * ⚠ 観測点は「焼く関数が呼び直されたか」+「**新しい条件で呼んだか**」。
 * 呼び直しただけで前の幅を渡す実装では意味がない。
 */
describe('幅と dpr を変えたときの焼き直し(P8 段㉘)', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 200)); // 間引き(150ms)を越える
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  /** 器 1 つを焼いた状態まで進める。 */
  async function painted(width: number): Promise<{ b: HTMLElement; scope: MermaidScope }> {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const host = b.querySelector('[data-pkc-mermaid-src]')!;
    setPaneWidth(host, width);
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await settle();
    return { b, scope };
  }

  it('⚠ 器の**親**を観る(器そのものではない ── 焼く度に鳴る輪になる)', async () => {
    const { b, scope } = await painted(700);
    const host = b.querySelector('[data-pkc-mermaid-src]')!;
    expect(roObserved, '幅を観ていない').toHaveLength(1);
    expect(roObserved[0], '器そのものを観ている(焼く → 器が広がる → また焼く)').toBe(
      host.parentElement,
    );
    scope.dispose();
    b.remove();
  });

  it('🔴 ペインが広がったら、**新しい幅で**焼き直す', async () => {
    const { b, scope } = await painted(700);
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);
    const before = vi.mocked(renderToPng).mock.calls[0]![0].width;

    setPaneWidth(b.querySelector('[data-pkc-mermaid-src]')!, 1200);
    fireResize!();
    await settle();

    expect(vi.mocked(renderToPng), '幅が変わっても焼き直していない').toHaveBeenCalledTimes(2);
    const after = vi.mocked(renderToPng).mock.calls[1]![0].width;
    // ⚠ **広い幅で**焼いている(呼び直しただけで前の幅を渡すと意味がない)
    expect(after, `幅が更新されていない(${before} → ${after})`).toBeGreaterThan(before);
    scope.dispose();
    b.remove();
  });

  it('🔴 dpr が変わったら、**新しい dpr で**焼き直す', async () => {
    const { b, scope } = await painted(700);
    expect(vi.mocked(renderToPng).mock.calls[0]![0].dpr).toBe(1);

    vi.stubGlobal('devicePixelRatio', 3);
    fireDpr!();
    await settle();

    expect(vi.mocked(renderToPng), 'dpr が変わっても焼き直していない').toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderToPng).mock.calls[1]![0].dpr, 'dpr が更新されていない').toBe(3);
    scope.dispose();
    b.remove();
  });

  /**
   * 🔴 **何も変わっていない通知では焼かない**。`ResizeObserver` は高さの変化でも
   * 鳴る(焼いた `<img>` を入れた瞬間にも鳴る)ので、鳴るたびに焼くと
   * **焼く → 鳴る → 焼く**の輪になり、メインスレッドを掴んだまま離さない。
   */
  it('🔴 幅も dpr も変わっていない通知では焼き直さない(輪を作らない)', async () => {
    const { b, scope } = await painted(700);
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);

    fireResize!();
    await settle();
    fireResize!();
    await settle();

    expect(vi.mocked(renderToPng), '変わっていないのに焼き直した').toHaveBeenCalledTimes(1);
    scope.dispose();
    b.remove();
  });

  /**
   * ⚠ 幅は 16px 刻みに丸めてある ── ドラッグ中の 1px ずつの変化で焼かない。
   * これが効いていないと、ペインを掴んで動かしている間ずっと焼き続ける。
   */
  it('🔴 わずかな幅の変化では焼き直さない(丸めが効いている)', async () => {
    const { b, scope } = await painted(704);
    setPaneWidth(b.querySelector('[data-pkc-mermaid-src]')!, 707);
    fireResize!();
    await settle();
    expect(vi.mocked(renderToPng), '1px の変化で焼き直した').toHaveBeenCalledTimes(1);
    scope.dispose();
    b.remove();
  });

  it('🔴 畳んだら引き金も畳む(外した面のために観測を残さない)', async () => {
    const { b, scope } = await painted(700);
    scope.dispose();
    expect(roDisconnected, '幅の観測器が残っている').toBe(1);
    expect(mqRemoved, 'dpr の問いが残っている').toBeGreaterThan(0);

    // 畳んだ後に鳴っても焼かない
    setPaneWidth(b.querySelector('[data-pkc-mermaid-src]')!, 1400);
    fireResize!();
    await settle();
    expect(vi.mocked(renderToPng), '畳んだ後に焼いた').toHaveBeenCalledTimes(1);
    b.remove();
  });
});

/**
 * P8 段㉘: 🔴 **掴んで動かしている間は焼かない**(間引き)。
 *
 * `ResizeObserver` はペインをドラッグしている間フレームごとに鳴る。焼くのは
 * メインスレッドなので、鳴るたびに焼くと**掴んでいる間ずっと詰まる**
 * (しかも途中の幅で焼いた絵は、離した瞬間に全部捨てられる)。
 *
 * ⚠ 観測点は「間引きの秒数」ではなく「**途中の幅で焼かなかったか**」──
 * 秒数を見る test は実装を写しただけで、何も守らない。
 */
describe('幅を掴んで動かしている間の間引き(P8 段㉘)', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🔴 ドラッグ中の途中の幅では焼かず、**落ち着いた幅で 1 回だけ**焼く', async () => {
    const b = block('graph TD\n A-->B');
    document.body.append(b);
    const host = b.querySelector('[data-pkc-mermaid-src]')!;
    setPaneWidth(host, 700);
    const scope = hydrateMermaid(b);
    fire!([observed[0]!]);
    await new Promise((r) => setTimeout(r, 200));
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);

    // 掴んで動かす(フレームごとに幅が変わって鳴る)
    for (const w of [900, 1100, 1300]) {
      setPaneWidth(host, w);
      fireResize!();
      await new Promise((r) => setTimeout(r, 15)); // 1 フレームぶん(間引きより短い)
    }
    // 離した後、落ち着くのを待つ
    await new Promise((r) => setTimeout(r, 250));

    expect(
      vi.mocked(renderToPng),
      '途中の幅でも焼いている(掴んでいる間ずっと焼き続ける)',
    ).toHaveBeenCalledTimes(2);
    // ⚠ **最後の幅**で焼けている(途中で止まっていない)
    const last = vi.mocked(renderToPng).mock.calls[1]![0].width;
    expect(last, `落ち着いた幅で焼いていない(${last})`).toBeGreaterThan(1200);

    scope.dispose();
    b.remove();
  });
});
