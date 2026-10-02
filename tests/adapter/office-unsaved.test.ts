/**
 * 🔴 **Office の窓の中に「保存していない変更」が在るか / 別の文書へ替える前の門**(#1228 穴②)。
 *
 * ⚠ `public/office/office-unsaved.js` は **bundle されない素の JS**(`host.html` が `<script src>` で
 * 読む)。`readFileSync` + `new Function` で**実 file を読んで**当てる
 * (`office-save-watch.test.ts` と同じ形 ── 写経すると本物とずれる)。
 *
 * 🔴 **この fake は、実ブラウザで測った UNO 橋の形をそのまま写している**(2026-10-02、
 * `lo-0c031979e70b-run34848755531`):
 *   - `Module.uno_init`(Promise)→ `Module.uno.com.sun.star.<名前空間>.<X>.query(wrapper)`
 *   - `getUnoComponentContext().getValueByName('/singletons/com.sun.star.frame.theDesktop').get()`
 *   - `XModifiable.query(...)` は **Start Center では `null`**、`isModified()` の戻りは **0 / 1**
 *   - wrapper は**手で `delete()`** する(embind)
 * ⚠ 本物の橋との合意は unit では言えない ── 実ブラウザの smoke / 手元の probe が見る。
 *
 * 🔴 守る主張:
 * 1. 開いている**どの**文書でも、保存していない変更が在れば `true`(前面の 1 件だけを見ない)
 * 2. **聞けなかった(`null`)と「無い(`false`)」を取り違えない**
 * 3. wrapper を**全部**解放する(呼ぶたびに積まない)
 * 4. 門: 在れば聞く / 無ければ**聞かずに替える**(対照群)/ 停止していれば聞かない
 * 5. 「やめる」は替えずに本体へ返す / 「開く」は**最後に頼まれた**文書へ替える
 * 6. 🔴 確認の箱の「やめる」の近道(#1266): Escape は**箱の外に焦点が在っても**効き、LO へ流さない /
 *    背景を押すと焦点が「やめる」へ戻る(ボタンの押しは邪魔しない)/ 閉じたら外れる
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

interface Hooks {
  getLo(): unknown;
  isDead(): boolean;
  replace(url: string): void;
  show(): void;
  hide(): void;
  declined(): void;
}
interface Gate {
  isOpen(): boolean;
  request(url: string): Promise<void>;
  accept(): void;
  cancel(): void;
  abort(): void;
}
interface Api {
  anyModified(lo: unknown): Promise<boolean | null>;
  createGate(h: Hooks): Gate;
  createDialogKeys(
    doc: FakeTarget,
    el: FakeTarget,
    cancelBtn: { click(): void; focus(): void },
  ): { arm(): void; disarm(): void };
}

/** `addEventListener` を記録する偽の相手(capture の有無も見る)。 */
class FakeTarget {
  readonly on: { type: string; fn: (ev: unknown) => void; capture: boolean }[] = [];
  addEventListener(type: string, fn: (ev: unknown) => void, capture?: boolean): void {
    this.on.push({ type, fn, capture: capture === true });
  }
  removeEventListener(type: string, fn: (ev: unknown) => void, capture?: boolean): void {
    const i = this.on.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true));
    if (i >= 0) this.on.splice(i, 1);
  }
  fire(type: string, ev: unknown): void {
    for (const l of [...this.on]) if (l.type === type) l.fn(ev);
  }
}

function load(): Api {
  const src = readFileSync('public/office/office-unsaved.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeUnsaved as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}
const api = load();

/** embind の wrapper 1 つ。`delete()` を数える。 */
function makeLive() {
  const state = { created: 0, deleted: 0 };
  const wrap = <T extends object>(o: T): T & { delete(): void } => {
    state.created += 1;
    return Object.assign(o, { delete: () => { state.deleted += 1; } });
  };
  return { state, wrap };
}

interface FakeDoc { modified: 0 | 1 | 'throws' | 'not-modifiable' }

/** 実測した橋の形の fake。`docs` が Desktop の components(Start Center は 'not-modifiable')。 */
function fakeLo(docs: readonly FakeDoc[], opts: { ctxThrows?: boolean; enumThrowsAfter?: number } = {}) {
  const live = makeLive();
  const { wrap } = live;
  let calls = 0;
  const lo = {
    uno_init: Promise.resolve(),
    getUnoComponentContext() {
      calls += 1;
      if (opts.ctxThrows) throw new Error('ctx');
      return wrap({
        getValueByName: () => wrap({ get: () => wrap({ tag: 'desktop' }) }),
      });
    },
    uno: {
      com: {
        sun: {
          star: {
            frame: {
              XDesktop: {
                query: () => wrap({
                  getComponents: () => wrap({
                    createEnumeration: () => {
                      let i = 0;
                      return wrap({
                        hasMoreElements: () => {
                          if (opts.enumThrowsAfter !== undefined && i >= opts.enumThrowsAfter) throw new Error('enum');
                          return i < docs.length;
                        },
                        nextElement: () => { const d = docs[i]!; i += 1; return wrap({ get: () => wrap({ doc: d }) }); },
                      });
                    },
                  }),
                }),
              },
            },
            util: {
              XModifiable: {
                query: (el: { doc: FakeDoc }) => {
                  if (el.doc.modified === 'not-modifiable') return null;
                  return wrap({
                    isModified: () => {
                      if (el.doc.modified === 'throws') throw new Error('isModified');
                      return el.doc.modified;
                    },
                  });
                },
              },
            },
          },
        },
      },
    },
  };
  return { lo, live, calls: () => calls };
}

describe('anyModified ── LO に聞く', () => {
  it('🔴 保存していない変更が在れば true / 無ければ false(0 と 1 を取り違えない)', async () => {
    expect(await api.anyModified(fakeLo([{ modified: 1 }]).lo), '在る').toBe(true);
    expect(await api.anyModified(fakeLo([{ modified: 0 }]).lo), '無い(対照群)').toBe(false);
  });

  it('🔴 開いている文書の **どれか** が未保存なら true(前面の 1 件だけを見ない)', async () => {
    expect(await api.anyModified(fakeLo([{ modified: 0 }, { modified: 1 }]).lo)).toBe(true);
    expect(await api.anyModified(fakeLo([{ modified: 1 }, { modified: 0 }]).lo)).toBe(true);
    expect(await api.anyModified(fakeLo([{ modified: 0 }, { modified: 0 }]).lo)).toBe(false);
  });

  it('Start Center だけ(XModifiable が取れない)は「無い」', async () => {
    expect(await api.anyModified(fakeLo([{ modified: 'not-modifiable' }]).lo)).toBe(false);
    // Start Center と未保存の文書が同居 ── 文書のほうを見る
    expect(await api.anyModified(fakeLo([{ modified: 'not-modifiable' }, { modified: 1 }]).lo)).toBe(true);
  });

  it('🔴 聞けなかったときは false ではなく null(「無かった」と取り違えない)', async () => {
    expect(await api.anyModified(null), 'LO がまだ無い').toBeNull();
    expect(await api.anyModified({}), '橋が無い').toBeNull();
    expect(await api.anyModified(fakeLo([{ modified: 1 }], { ctxThrows: true }).lo), '例外').toBeNull();
  });

  it('1 件が isModified で投げても、他の文書を見る / 数え途中の例外でも在ると分かった分は捨てない', async () => {
    expect(await api.anyModified(fakeLo([{ modified: 'throws' }, { modified: 1 }]).lo)).toBe(true);
    // 1 件目で在ると分かった後に列挙が投げる → 消す側へ倒さない
    expect(await api.anyModified(fakeLo([{ modified: 1 }, { modified: 0 }], { enumThrowsAfter: 1 }).lo)).toBe(true);
    // 在ると分かる前に投げたら「聞けなかった」
    expect(await api.anyModified(fakeLo([{ modified: 0 }, { modified: 1 }], { enumThrowsAfter: 1 }).lo)).toBeNull();
  });

  it('🔴 wrapper を全部解放する(true の経路も false の経路も。呼ぶたびに積まない)', async () => {
    for (const docs of [[{ modified: 1 }], [{ modified: 0 }], [{ modified: 'not-modifiable' }], [{ modified: 0 }, { modified: 1 }]] as FakeDoc[][]) {
      const f = fakeLo(docs);
      await api.anyModified(f.lo);
      expect(f.live.state.created, '空振り防止: 何かは作っている').toBeGreaterThan(3);
      expect(f.live.state.deleted, `作った ${f.live.state.created} 個を全部 delete する`).toBe(f.live.state.created);
    }
  });

  it('🔴 例外の経路でも wrapper を全部解放する(isModified が投げる / 列挙が途中で投げる ── tick ごとに呼ばれるので積むと効く)', async () => {
    const cases: [string, FakeDoc[], { enumThrowsAfter?: number }][] = [
      ['isModified が投げる', [{ modified: 'throws' }, { modified: 0 }], {}],
      ['列挙が途中で投げる(在ると分かった後)', [{ modified: 1 }, { modified: 0 }], { enumThrowsAfter: 1 }],
      ['列挙が途中で投げる(分かる前)', [{ modified: 0 }, { modified: 1 }], { enumThrowsAfter: 1 }],
    ];
    for (const [label, docs, opts] of cases) {
      const f = fakeLo(docs, opts);
      await api.anyModified(f.lo);
      expect(f.live.state.created, `空振り防止(${label})`).toBeGreaterThan(3);
      expect(f.live.state.deleted, `${label}: 作った ${f.live.state.created} 個を全部 delete する`).toBe(f.live.state.created);
    }
  });

  it('橋の初期化(uno_init)が解決しない相手は 3 秒で諦める(null)── 永久に待たない', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeLo([{ modified: 1 }]);
      (f.lo as { uno_init: Promise<void> }).uno_init = new Promise(() => {});
      const p = api.anyModified(f.lo);
      await vi.advanceTimersByTimeAsync(2900);
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, '3 秒より前には諦めない').toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createGate ── 別の文書へ替える前の門', () => {
  function gateOf(lo: unknown, dead = false) {
    const log: string[] = [];
    const replaced: string[] = [];
    const state = { dead };
    const gate = api.createGate({
      getLo: () => lo,
      isDead: () => state.dead,
      replace: (u) => { replaced.push(u); log.push('replace'); },
      show: () => { log.push('show'); },
      hide: () => { log.push('hide'); },
      declined: () => { log.push('declined'); },
    });
    return { gate, log, replaced, state };
  }

  it('🔴 未保存が在れば、替えずに確認を出す', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    await g.gate.request('host.html?name=b');
    expect(g.log).toEqual(['show']);
    expect(g.replaced, '確認の答えを待つ間は替えない').toEqual([]);
    expect(g.gate.isOpen()).toBe(true);
  });

  it('🔴 対照群: 未保存が無ければ確認なしで替える(手数を増やさない)', async () => {
    const g = gateOf(fakeLo([{ modified: 0 }]).lo);
    await g.gate.request('host.html?name=b');
    expect(g.log).toEqual(['replace']);
    expect(g.replaced).toEqual(['host.html?name=b']);
  });

  it('聞けなかった(橋が無い)ときは、今まで通り替える', async () => {
    const g = gateOf({});
    await g.gate.request('u');
    expect(g.log).toEqual(['replace']);
  });

  it('🔴 停止している窓には聞かない(読み込み直しの動線を確認で塞がない)', async () => {
    const f = fakeLo([{ modified: 1 }]);
    const g = gateOf(f.lo, true);
    await g.gate.request('u');
    expect(g.log).toEqual(['replace']);
    expect(f.calls(), 'LO へ聞いていない').toBe(0);
  });

  it('LO がまだ起動していない(lo が無い)ときも聞かずに替える', async () => {
    const g = gateOf(undefined);
    await g.gate.request('u');
    expect(g.log).toEqual(['replace']);
  });

  it('🔴 「やめる」: 替えず、確認を畳み、本体へ「やめた」を返す', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    await g.gate.request('u');
    g.gate.cancel();
    expect(g.log).toEqual(['show', 'hide', 'declined']);
    expect(g.replaced, '「やめる」で替えない').toEqual([]);
    expect(g.gate.isOpen()).toBe(false);
  });

  it('🔴 「開く」: 確認を畳んで替える(本体へ「やめた」は返さない)', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    await g.gate.request('host.html?name=b');
    g.gate.accept();
    expect(g.log).toEqual(['show', 'hide', 'replace']);
    expect(g.replaced).toEqual(['host.html?name=b']);
    expect(g.log).not.toContain('declined');
  });

  it('🔴 確認が出ている間に別の文書を頼まれたら、箱は 1 つのまま「開く」で最後の文書へ替わる', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    await g.gate.request('B');
    await g.gate.request('C');
    expect(g.log.filter((x) => x === 'show').length, '箱を 2 つ出さない').toBe(1);
    g.gate.accept();
    expect(g.replaced).toEqual(['C']);
  });

  it('確かめている最中に来た 2 件目でも、箱は 1 つ(最後の行き先)', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    const p1 = g.gate.request('B');
    const p2 = g.gate.request('C');
    await Promise.all([p1, p2]);
    expect(g.log.filter((x) => x === 'show').length).toBe(1);
    g.gate.accept();
    expect(g.replaced).toEqual(['C']);
  });

  it('確認が出ていないときの accept / cancel は何もしない(二重に押しても替わらない・返さない)', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    g.gate.accept();
    g.gate.cancel();
    expect(g.log).toEqual([]);
    await g.gate.request('B');
    g.gate.cancel();
    g.gate.cancel();
    expect(g.log.filter((x) => x === 'declined').length, '「やめた」は 1 度だけ').toBe(1);
  });

  it('停止したら(abort)確認を畳むだけで、「やめた」は返さない', async () => {
    const g = gateOf(fakeLo([{ modified: 1 }]).lo);
    await g.gate.request('B');
    g.gate.abort();
    expect(g.log).toEqual(['show', 'hide']);
    expect(g.gate.isOpen()).toBe(false);
  });
});

describe('確認の箱の「やめる」の近道(#1266)', () => {
  function rig() {
    const doc = new FakeTarget();
    const el = new FakeTarget();
    const log: string[] = [];
    const cancel = { click: () => log.push('click'), focus: () => log.push('focus') };
    const keys = api.createDialogKeys(doc, el, cancel);
    const key = (k: string) => {
      const ev = {
        key: k,
        prevented: false,
        stopped: false,
        preventDefault() { ev.prevented = true; },
        stopPropagation() { ev.stopped = true; },
      };
      doc.fire('keydown', ev);
      return ev;
    };
    const down = (onButton: boolean) => {
      const ev = {
        target: { closest: (sel: string) => (onButton && sel === 'button' ? {} : null) },
        prevented: false,
        preventDefault() { ev.prevented = true; },
      };
      el.fire('mousedown', ev);
      return ev;
    };
    return { doc, el, log, keys, key, down };
  }

  it('🔴 Escape は document の capture で受ける(箱の外 = body に焦点が落ちていても効く)/ LO へ流さない', () => {
    const r = rig();
    r.keys.arm();
    // 🔑 箱(`el`)の keydown では受けない ── 焦点が body に在るとき、箱は鍵を見ない
    expect(r.el.on.some((l) => l.type === 'keydown'), '箱の中でだけ Escape を受けている').toBe(false);
    expect(r.doc.on.find((l) => l.type === 'keydown')?.capture, 'capture でない(LO が先に受ける)').toBe(true);
    const ev = r.key('Escape');
    expect(r.log).toEqual(['click']);
    expect(ev.prevented, '既定の動作を止めていない').toBe(true);
    expect(ev.stopped, 'LO へ Escape が流れる').toBe(true);
  });

  it('対照群: Escape 以外の鍵は何もしない・止めない(LO の入力を奪わない)', () => {
    const r = rig();
    r.keys.arm();
    const ev = r.key('a');
    expect(r.log).toEqual([]);
    expect(ev.prevented || ev.stopped).toBe(false);
  });

  it('🔴 背景を押すと焦点が「やめる」へ戻る / ボタンの押しは邪魔しない(click を殺さない)', () => {
    const r = rig();
    r.keys.arm();
    const bg = r.down(false);
    expect(r.log, '背景を押しても焦点が戻らない').toEqual(['focus']);
    expect(bg.prevented, '焦点が body へ落ちるのを止めていない').toBe(true);
    r.log.length = 0;
    const btn = r.down(true);
    expect(r.log).toEqual([]);
    expect(btn.prevented, 'ボタンの押しまで止めている').toBe(false);
  });

  it('🔴 閉じたら外れる(閉じた後の Escape を LO から奪わない)/ 二重に arm しても受け手は 1 つ', () => {
    const r = rig();
    r.keys.arm();
    r.keys.arm();
    expect(r.doc.on.filter((l) => l.type === 'keydown')).toHaveLength(1);
    expect(r.el.on.filter((l) => l.type === 'mousedown')).toHaveLength(1);
    r.keys.disarm();
    expect(r.doc.on).toHaveLength(0);
    expect(r.el.on).toHaveLength(0);
    const ev = r.key('Escape');
    expect(r.log).toEqual([]);
    expect(ev.prevented || ev.stopped, '閉じた後の Escape を止めている').toBe(false);
  });
});
