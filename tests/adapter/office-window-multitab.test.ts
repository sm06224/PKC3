/**
 * 🔴 **Office の窓を、複数のタブ・短い間隔の連続操作から守る**(O-1 / O-4 / O-5 / O-8)。
 *
 * ⚠ 本物の `BroadcastChannel` と同じ意味論の偽物を使う ── **送ったタブ自身には返らず、他の全タブへ届く**。
 *   1 本の偽物に全員が繋がる形(`office-window.test.ts` の `fakeChannel`)では、「別のタブの放送」が作れない。
 * 🔑 観測点は「放送が飛んだか」ではなく、**窓が最後に受け取った文書の名前 / bytes** と**タブが見せた一言**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OfficeWindow,
  supersedesSent,
  type OfficeWindowEvent,
} from '../../src/adapter/platform/office/office-window';

function makeBus() {
  interface Ch {
    onmessage: ((ev: MessageEvent) => void) | null;
    postMessage(d: unknown): void;
    close(): void;
  }
  const chans: Ch[] = [];
  const make = (): Ch => {
    const c: Ch = {
      onmessage: null,
      postMessage(d: unknown) {
        for (const o of chans) {
          if (o !== c) queueMicrotask(() => o.onmessage?.({ data: structuredClone(d) } as MessageEvent));
        }
      },
      close() {},
    };
    chans.push(c);
    return c;
  };
  return { make };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await tick();
};

function tab(bus: ReturnType<typeof makeBus>, clock: { t: number }, opened: string[] = []): OfficeWindow {
  return new OfficeWindow({
    makeChannel: bus.make,
    openWindow: (u) => { opened.push(u); },
    now: () => clock.t,
    baseUrl: 'http://x/',
  });
}

/** 窓役。⚠ 本物の `host.html` と同じく、文書を求めた後は**最初に着いた 1 通だけ**を取る。 */
function fakeHost(bus: ReturnType<typeof makeBus>) {
  const host = bus.make();
  const docs: { name: string; bytes: number[]; token: string }[] = [];
  /** 窓が聞いた「読み直して」の名前。 */
  const reloads: string[] = [];
  let waiting = false;
  host.onmessage = (ev) => {
    const d = ev.data as { pkc3Office: string; payload: { name?: string; bytes?: Uint8Array; token?: string } };
    if (d.pkc3Office === 'reload-request') {
      reloads.push(d.payload.name ?? '');
      waiting = true;
      host.postMessage({ pkc3Office: 'ready-for-document', payload: {} });
    }
    if (d.pkc3Office === 'document' && waiting) {
      waiting = false;
      docs.push({ name: d.payload.name ?? '', bytes: [...(d.payload.bytes ?? [])], token: d.payload.token ?? '' });
    }
  };
  return {
    docs,
    reloads,
    say: (type: string, payload: Record<string, unknown> = {}) => host.postMessage({ pkc3Office: type, payload }),
    /** 起動直後の窓: 文書を待つ。 */
    startWaiting: () => { waiting = true; host.postMessage({ pkc3Office: 'ready-for-document', payload: {} }); },
  };
}

describe('O-4: 別のタブが別の文書を頼んだら、古い控えを送り直さない', () => {
  it('🔴 控えを持つタブ A が居ても、タブ B の頼んだ文書が窓に出る', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const host = fakeHost(bus);
    const A = tab(bus, clock);
    const B = tab(bus, clock);
    A.open({ name: 'X.docx', expectDocument: true });
    A.provideDocument('X.docx', new Uint8Array([1]), 'lidX', [], async () => ({ bytes: new Uint8Array([1]) }));
    host.startWaiting();
    await settle();
    expect(host.docs.map((d) => d.name), '前提: A の文書が窓に出ている').toEqual(['X.docx']);
    host.say('alive', { visible: true });
    await settle();
    clock.t += 1000;

    // B が別の文書 Y を頼む(読み込みは遅れて届く ── 添付を IDB から読むので)
    expect(B.open({ name: 'Y.docx', expectDocument: true }).kind).toBe('already-open');
    await settle();
    B.provideDocument('Y.docx', new Uint8Array([2]), 'lidY', [], async () => ({ bytes: new Uint8Array([2]) }));
    await settle();

    expect(host.docs.map((d) => d.name), 'A が古い X を先に送り直した').toEqual(['X.docx', 'Y.docx']);
    expect(host.docs[1]!.token).toBe('lidY');
  });

  it('🔴 窓に渡された別の文書の放送でも、控えを手放す(頼みを聞き逃していた場合)', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const host = fakeHost(bus);
    const A = tab(bus, clock);
    const B = tab(bus, clock);
    A.open({ name: 'X.docx', expectDocument: true });
    A.provideDocument('X.docx', new Uint8Array([1]), 'lidX', [], async () => ({ bytes: new Uint8Array([1]) }));
    host.startWaiting();
    await settle();
    host.say('alive', { visible: true });
    await settle();
    // B は窓が生きている間に頼む。窓が `ready-for-document` を言う前に Y が着いた形
    B.open({ name: 'Y.docx', expectDocument: true });
    B.provideDocument('Y.docx', new Uint8Array([2]), 'lidY');
    await settle();
    // 窓が作り直されて、もう一度文書を求めた ── A が X を送り直してはいけない
    host.startWaiting();
    await settle();
    expect(host.docs.map((d) => d.name).filter((n) => n === 'X.docx'), 'A が X を 2 度送った').toHaveLength(1);
  });

  it('対照群: 同じ文書の頼みなら控えは残る(窓が作り直されたら送り直す)', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const host = fakeHost(bus);
    const A = tab(bus, clock);
    const B = tab(bus, clock);
    A.open({ name: 'X.docx', expectDocument: true });
    A.provideDocument('X.docx', new Uint8Array([1]), 'lidX', [], async () => ({ bytes: new Uint8Array([1]) }));
    host.startWaiting();
    await settle();
    host.say('alive', { visible: true });
    await settle();
    // B が同じ X を頼む(まだ届いていない)── A の控えは古くない。窓が求め直せば A が X を送る
    B.open({ name: 'X.docx', expectDocument: true });
    await settle();
    host.startWaiting();
    await settle();
    expect(host.docs.length, '同じ文書の頼みで A の控えを手放した').toBeGreaterThanOrEqual(2);
    expect(host.docs.every((d) => d.name === 'X.docx')).toBe(true);
  });

  it('判定: 合言葉が分かれば合言葉で、無ければ名前で比べる', () => {
    const sent = { name: 'X.docx', token: 'lidX' };
    expect(supersedesSent(sent, { name: 'Y.docx', token: 'lidY' })).toBe(true);
    // 名前が違っても合言葉が同じ(改名された添付)なら同じ文書
    expect(supersedesSent(sent, { name: 'X2.docx', token: 'lidX' })).toBe(false);
    expect(supersedesSent(sent, { name: 'Y.docx' })).toBe(true);
    expect(supersedesSent(sent, { name: 'X.docx' })).toBe(false);
    // 合言葉が空(窓の中で新規に作った文書)は名前で見る
    expect(supersedesSent(sent, { name: 'X.docx', token: '' })).toBe(false);
  });
});

describe('O-5: 起動の途中で 2 つ目の文書を頼んだとき', () => {
  it('🔴 窓が起動の途中で聞き逃した頼みを、生きてから頼み直す(2 つ目の文書が窓に届く)', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const opened: string[] = [];
    const W = tab(bus, clock, opened);
    expect(W.open({ name: 'A.docx', expectDocument: true }).kind).toBe('opened');
    clock.t += 1000;
    // 起動の猶予の内側で 2 つ目 ── 窓はまだ放送を聞いていない
    expect(W.open({ name: 'B.docx', expectDocument: true }).kind).toBe('already-open');
    expect(opened, '窓を 2 つ開いた').toHaveLength(1);
    // A の読み込みだけ先に終わる
    W.provideDocument('A.docx', new Uint8Array([1]), 'lidA');
    // 窓が起動して聞き始め、A を求めて受け取る
    const host = fakeHost(bus);
    host.startWaiting();
    await settle();
    expect(host.docs.map((d) => d.name), '前提: A は渡った').toEqual(['A.docx']);
    host.say('alive', { visible: true });
    await settle();
    // B の読み込みが終わった ── 窓はもう A で動いている。頼み直さないと B は届かない
    W.provideDocument('B.docx', new Uint8Array([2]), 'lidB');
    await settle();
    expect(host.docs.map((d) => d.name), 'B が窓に届いていない').toEqual(['A.docx', 'B.docx']);
    expect(host.reloads, '頼み直しは B の名前で').toEqual(['B.docx']);
  });

  it('🔴 窓が生きる前に B が届いたら、頼み直さない(窓を二度作り直さない)', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const W = tab(bus, clock);
    W.open({ name: 'A.docx', expectDocument: true });
    clock.t += 1000;
    W.open({ name: 'B.docx', expectDocument: true });
    W.provideDocument('A.docx', new Uint8Array([1]), 'lidA');
    W.provideDocument('B.docx', new Uint8Array([2]), 'lidB');
    const host = fakeHost(bus);
    host.startWaiting();
    await settle();
    // 窓の名前は URL の A のままでも、中身は B(最後に頼んだ文書)── 名前は封筒の名前に従う(host.html の pin は下)
    expect(host.docs.map((d) => d.name)).toEqual(['B.docx']);
    host.say('alive', { visible: true });
    await settle();
    expect(host.reloads, '渡し終えているのに頼み直した').toEqual([]);
    expect(host.docs, '頼み直して B を 2 度送った').toHaveLength(1);
  });
});

describe('O-8: 保存の結果は、窓を開いたタブにも届く', () => {
  it('🔴 窓へ文書を渡したタブにだけ、結果が listener へ届く', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const holder = tab(bus, clock);
    const follower = tab(bus, clock);
    const other = tab(bus, clock);
    follower.open({ name: 'X.docx', expectDocument: true });
    follower.provideDocument('X.docx', new Uint8Array([1]), 'lidX');
    const host = fakeHost(bus);
    host.startWaiting();
    await settle();
    const got: OfficeWindowEvent[] = [];
    const gotOther: OfficeWindowEvent[] = [];
    follower.onEvent((e) => got.push(e));
    other.onEvent((e) => gotOther.push(e));
    holder.relaySaveResult({ token: 'lidX', kind: 'notice', text: 'Office で保存した内容を取り込みました: 「X.docx」', openLid: 'lidX' });
    await settle();
    expect(got).toEqual([
      { type: 'save-result', token: 'lidX', kind: 'notice', text: 'Office で保存した内容を取り込みました: 「X.docx」', openLid: 'lidX' },
    ]);
    expect(gotOther, '窓を開いていないタブにも出た(重なって出る)').toEqual([]);
  });

  it('合言葉が空の結果は運ばない(窓の中で新規に作った文書は、頼んだタブが居ない)', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const a = tab(bus, clock);
    const b = tab(bus, clock);
    const got: OfficeWindowEvent[] = [];
    b.onEvent((e) => got.push(e));
    a.relaySaveResult({ token: '', kind: 'fail', text: 'x' });
    await settle();
    expect(got).toEqual([]);
  });

  it('壊れた通知(字が無い / 種類が違う)は捨てる', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const b = tab(bus, clock);
    b.open({ name: 'X.docx', expectDocument: true });
    b.provideDocument('X.docx', new Uint8Array([1]), 'lidX');
    const host = fakeHost(bus);
    host.startWaiting();
    await settle();
    const got: OfficeWindowEvent[] = [];
    b.onEvent((e) => got.push(e));
    host.say('save-result', { token: 'lidX', kind: 'notice', text: '' });
    host.say('save-result', { token: 'lidX', kind: 'weird', text: 'x' });
    host.say('save-result', { token: '', kind: 'fail', text: 'x' });
    await settle();
    expect(got).toEqual([]);
  });
});

describe('窓がいま出している文書(O-2 の材料)', () => {
  it('🔴 生きている窓が、その合言葉の文書を出している間だけ真', async () => {
    const bus = makeBus();
    const clock = { t: 100_000 };
    const W = tab(bus, clock);
    const host = fakeHost(bus);
    expect(W.showsToken('lidX'), '開いていないのに真').toBe(false);
    W.open({ name: 'X.docx', expectDocument: true });
    W.provideDocument('X.docx', new Uint8Array([1]), 'lidX');
    host.startWaiting();
    await settle();
    host.say('alive', { visible: true });
    await settle();
    expect(W.showsToken('lidX')).toBe(true);
    expect(W.showsToken('lidY'), '別の文書なのに真').toBe(false);
    expect(W.showsToken(''), '空の合言葉は誰のでもない').toBe(false);
    clock.t += 10_000;
    expect(W.showsToken('lidX'), '窓が絶えたのに真').toBe(false);
  });
});

describe('配線(原文 pin ── host.html と main.ts はどの test からも実行されない)', () => {
  const host = readFileSync('public/office/host.html', 'utf-8');
  const main = readFileSync('src/main.ts', 'utf-8');

  it('🔴 窓は、受け取った文書の名前に従う(URL の名前は窓を開いた時の依頼にすぎない)', () => {
    const i = host.indexOf("d.pkc3Office === 'document'");
    expect(i, '文書を受ける枝が見つからない').toBeGreaterThan(0);
    const branch = host.slice(i, i + 1600);
    expect(branch).toMatch(/docName\s*=\s*d\.payload\.name/);
    expect(branch).toMatch(/nameEl\.textContent\s*=\s*docName/);
  });

  it('🔴 本体は、手元のファイルを読み直しの口つきで渡している', () => {
    expect(main).toContain('provideStagedLocal(officeWindow, localOffice, staged)');
  });

  it('🔴 他のタブが引き取った結果を、出し口を変えずに見せている', () => {
    const i = main.indexOf("ev.type === 'save-result'");
    expect(i).toBeGreaterThan(0);
    const branch = main.slice(i, i + 700);
    expect(branch).toContain("type: 'OP_FAILED'");
    expect(branch).toContain("type: 'OP_NOTICE'");
    expect(main).toContain('relay: (r) => { officeWindow.relaySaveResult(r); }');
  });

  it('🔴 窓を開く前に、預かった保存を先に取り込む口が渡っている', () => {
    expect(main).toContain('adoptHeld: (lid) => officeSaveBack.adoptFor(lid)');
  });
});
