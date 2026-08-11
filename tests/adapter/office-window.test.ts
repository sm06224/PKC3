/** @vitest-environment happy-dom */
/**
 * O2: Office の**別窓**を開く・使い回す・閉じる(#88)。
 *
 * 守りたい主張:
 *  ① **窓は 1 つだけ**(2 つ立てると常駐 1.5GB)
 *  ② ポップアップ遮断を**黙って握らない**
 *  ③ **別 origin / 別の窓からの message を信じない**
 *  ④ 文書は「窓が受け取り準備できた」と言ってから渡す(user gesture を切らない)
 *  ⑤ 閉じたら参照を捨てる
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeWindow, OfficeWindowError } from '../../src/adapter/platform/office/office-window';

interface FakeWin {
  closed: boolean;
  focused: number;
  posted: { data: unknown; origin: string; transfer: unknown[] }[];
  replaced: string[];
  closedCount: number;
}

function fakeWindow(): FakeWin & Window {
  const w = {
    closed: false,
    focused: 0,
    posted: [] as FakeWin['posted'],
    replaced: [] as string[],
    closedCount: 0,
    focus() { w.focused += 1; },
    close() { w.closedCount += 1; w.closed = true; },
    postMessage(data: unknown, origin: string, transfer: unknown[] = []) {
      w.posted.push({ data, origin, transfer });
    },
    location: { replace: (u: string) => { w.replaced.push(u); } },
  };
  return w as unknown as FakeWin & Window;
}

/** 窓から親へ送られてくる message を模す。 */
function emit(source: unknown, pkc3Office: string, payload: unknown = {}, origin = location.origin): void {
  const ev = new MessageEvent('message', { data: { pkc3Office, payload }, origin });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OfficeWindow', () => {
  it('開くと host.html を、名前つきで開く', () => {
    const win = fakeWindow();
    const open = vi.fn<(url: string) => Window>(() => win);
    vi.stubGlobal('open', open);
    new OfficeWindow().open({ name: '資料.docx' });
    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0]![0], 'http://x/');
    expect(url.pathname).toContain('office/host.html');
    expect(url.searchParams.get('name')).toBe('資料.docx');
    // ⚠ 文書を渡さないときは `await-doc` を付けない ── 付けると窓が 15 秒無駄に待つ
    expect(url.searchParams.has('await-doc')).toBe(false);
  });

  it('🔴 窓は 1 つだけ ── 2 度目は使い回して前面に出す', () => {
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal('open', open);
    const ow = new OfficeWindow();
    ow.open({ name: 'a.docx' });
    ow.open({ name: 'b.docx' });
    expect(open, '2 つ目の窓を開いていない').toHaveBeenCalledTimes(1);
    expect(win.focused, '前面に出している').toBe(1);
  });

  it('使い回すとき、文書が在るなら URL ごと入れ替える(前の文書が残らない)', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const ow = new OfficeWindow();
    ow.open({ name: 'a.docx' });
    ow.open({ name: 'b.docx', bytes: new Uint8Array([1, 2, 3]) });
    expect(win.replaced.length, '読み直させている').toBe(1);
    expect(win.replaced[0]).toContain('name=b.docx');
    expect(win.replaced[0], '文書を待つよう伝えている').toContain('await-doc=1');
  });

  it('🔴 ポップアップ遮断を黙って握らない', () => {
    vi.stubGlobal('open', vi.fn(() => null));
    expect(() => new OfficeWindow().open()).toThrow(OfficeWindowError);
    expect(() => new OfficeWindow().open()).toThrow(/ポップアップ/);
  });

  it('🔴 文書は「準備できた」と言われてから渡す(transfer で)', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const ow = new OfficeWindow();
    ow.open({ name: 'x.docx', bytes: new Uint8Array([9, 8, 7]) });
    expect(win.posted.length, 'まだ送っていない').toBe(0);
    emit(win, 'ready-for-document');
    expect(win.posted.length, '準備できたら送る').toBe(1);
    const sent = win.posted[0]!;
    expect(sent.origin).toBe(location.origin);
    expect(sent.transfer.length, 'transfer で渡す(ゼロコピー)').toBe(1);
    expect(new Uint8Array(sent.transfer[0] as ArrayBuffer)).toEqual(new Uint8Array([9, 8, 7]));
    // ⚠ 2 度目の要求で二重送信しない(窓が読み直したときに古い bytes を送らない)
    emit(win, 'ready-for-document');
    expect(win.posted.length).toBe(1);
  });

  it('🔴 別 origin からの message は信じない', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const seen: string[] = [];
    new OfficeWindow().open({ bytes: new Uint8Array([1]), onEvent: (e) => seen.push(e.type) });
    emit(win, 'painted', { ms: 1 }, 'https://evil.example');
    expect(seen, '別 origin は届かない').toEqual([]);
    emit(win, 'painted', { ms: 1 });
    expect(seen).toEqual(['painted']);
  });

  it('🔴 別の窓からの message も信じない', () => {
    const win = fakeWindow();
    const other = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const seen: string[] = [];
    new OfficeWindow().open({ onEvent: (e) => seen.push(e.type) });
    emit(other, 'painted', { ms: 1 });
    expect(seen).toEqual([]);
  });

  it('対応外・未配備は、そのまま呼び出し側へ伝える', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const seen: unknown[] = [];
    new OfficeWindow().open({ onEvent: (e) => seen.push(e) });
    emit(win, 'unsupported', { missing: ['JSPI'] });
    emit(win, 'not-installed');
    expect(seen).toEqual([
      { type: 'unsupported', missing: ['JSPI'] },
      { type: 'not-installed' },
    ]);
  });

  it('close() で窓を閉じ、開いていない状態に戻る', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const ow = new OfficeWindow();
    ow.open();
    expect(ow.isOpen()).toBe(true);
    ow.close();
    expect(win.closedCount).toBe(1);
    expect(ow.isOpen()).toBe(false);
  });

  it('user が手で閉じたら、次の open は新しく開く', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const open = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubGlobal('open', open);
    const ow = new OfficeWindow();
    ow.open();
    first.closed = true; // user が × を押した
    expect(ow.isOpen()).toBe(false);
    ow.open();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('窓から closed が来たら、参照を捨てる', () => {
    const win = fakeWindow();
    vi.stubGlobal('open', vi.fn(() => win));
    const ow = new OfficeWindow();
    ow.open();
    emit(win, 'closed');
    expect(ow.isOpen()).toBe(false);
  });
});
