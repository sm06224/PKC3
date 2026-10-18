/**
 * 🔴 **手元のファイルを Office で開き、元のファイルへ書き戻す**(#432)。
 *
 * ⚠ ここで守るのは 4 つ:①**控えは 1 件**(押したら違うほうが開く、を作らない)
 * ②**取り出したら空にする**(閉じたのに戻ってくる、を作らない)
 * ③**書けなかったら false を返す**(黙って「保存しました」と言わない)
 * ④**session 限り**(handle をどこにも保存しない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalOfficeFiles, provideStagedLocal } from '../../src/adapter/platform/office/local-office-files';
import { OfficeWindow } from '../../src/adapter/platform/office/office-window';
import { isLocalFileToken } from '../../src/features/office/office-launch';
import type { LaunchedHandle } from '../../src/adapter/platform/launched-files';

/** 本物の handle の**必要な部分だけ**を真似る(`launched-files.ts` と同じ作法)。 */
function fakeHandle(over: Partial<LaunchedHandle> = {}) {
  const written: Uint8Array[] = [];
  let closed = false;
  const handle: LaunchedHandle = {
    kind: 'file',
    queryPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (d: unknown) => {
        written.push(d as Uint8Array);
      },
      close: async () => {
        closed = true;
      },
    }),
    ...over,
  } as LaunchedHandle;
  return { handle, written, isClosed: () => closed };
}

const bytes = (n: number) => new Uint8Array([n, n, n]);

describe('控える', () => {
  it('合言葉は「手元のファイル」の名前空間で作られる', () => {
    const s = new LocalOfficeFiles();
    const st = s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    expect(isLocalFileToken(st.token), 'lid と同じ名前空間で作っている').toBe(true);
  });

  it('名前が画面に出せる', () => {
    const s = new LocalOfficeFiles();
    expect(s.pendingName()).toBeNull();
    s.stage(fakeHandle().handle, '報告書.docx', bytes(1));
    expect(s.pendingName()).toBe('報告書.docx');
  });

  it('🔴 **控えは 1 件**(2 件来たら最後の 1 件)', () => {
    /**
     * ⚠ Office の窓は 1 枚しか無いので、積んでも開けるのは 1 件である。
     *   積むと「押したら違うほうが開いた」になる。
     */
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, '古い.docx', bytes(1));
    s.stage(fakeHandle().handle, '新しい.docx', bytes(2));
    expect(s.pendingName()).toBe('新しい.docx');
    expect(s.take()?.name).toBe('新しい.docx');
  });

  it('🔴 **取り出したら控えは空**(閉じたのに戻ってくる、を作らない)', () => {
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    expect(s.take()).not.toBeNull();
    expect(s.take(), '2 度目にもう一度開いてしまう').toBeNull();
    expect(s.pendingName()).toBeNull();
  });

  it('取り出すと、合言葉から名前が引けるようになる', () => {
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    const taken = s.take()!;
    expect(s.nameOf(taken.token)).toBe('a.docx');
  });

  it('⚠ 控えたまま(取り出す前)は、まだ合言葉と結ばれていない', () => {
    const s = new LocalOfficeFiles();
    const st = s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    expect(s.nameOf(st.token), '渡す前から書き戻せる状態になっている').toBeNull();
  });
});

describe('取り出さずに見る(peek。依頼 367 A)', () => {
  it('名前・大きさ・更新時刻を返し、取り出さない(確認で「やめる」を選ばれても控えたファイルを失わない)', () => {
    const s = new LocalOfficeFiles();
    expect(s.peek()).toBeNull();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1), 12345);
    expect(s.peek()).toEqual({ name: 'a.docx', size: 3, modifiedAt: 12345 });
    expect(s.peek(), '見たら無くなった').not.toBeNull();
    expect(s.take()?.name).toBe('a.docx');
    expect(s.peek(), '取り出した後も残っている').toBeNull();
  });

  it('更新時刻を渡さなければ null(訊く側へ倒す)', () => {
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    expect(s.peek()?.modifiedAt).toBeNull();
  });
});

describe('書き戻す', () => {
  it('🔴 元のファイルへ bytes を書いて閉じる', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle();
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(9))).toBe(true);
    expect(f.written).toHaveLength(1);
    expect([...f.written[0]!]).toEqual([9, 9, 9]);
    expect(f.isClosed(), '閉じていない(書き込みが確定しない)').toBe(true);
  });

  it('🔴 知らない合言葉には書かない(取り違えて別のファイルを潰さない)', async () => {
    const s = new LocalOfficeFiles();
    expect(await s.writeBack('local:999', bytes(1))).toBe(false);
  });

  it('🔴 ノートの lid で呼ばれても書かない', async () => {
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    s.take();
    expect(await s.writeBack('mta73ihn-0001', bytes(1))).toBe(false);
  });

  it('🔴 書けない handle は false(黙って「保存しました」と言わせない)', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle({ createWritable: undefined });
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(1)), '理由を区別していない').toBe('unsupported');
  });

  it('🔴 許可が下りなければ false(勝手に書かない)', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle({
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'denied',
    });
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(1)), '許可が得られなかった理由を区別していない').toBe('denied');
    expect(f.written, '断られたのに書いた').toHaveLength(0);
  });

  it('許可を求めて下りたら書く', async () => {
    const s = new LocalOfficeFiles();
    const ask = vi.fn(async () => 'granted');
    const f = fakeHandle({ queryPermission: async () => 'prompt', requestPermission: ask });
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(1))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(f.written).toHaveLength(1);
  });

  it('🔴 途中で投げても false(例外を user に見せない / 握り潰さない)', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle({
      createWritable: async () => {
        throw new Error('disk gone');
      },
    });
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    await expect(s.writeBack(t, bytes(1)), '理由が分からない例外に理由を作った').resolves.toBe(false);
  });

  it('🔴 例外の名前で言い分ける:許可が無い → denied / 元のファイルが動いた・閉じた → reopen', async () => {
    const cases: [string, string | false][] = [
      ['NotAllowedError', 'denied'],
      ['SecurityError', 'denied'],
      ['NotFoundError', 'reopen'],
      ['InvalidStateError', 'reopen'],
      ['QuotaExceededError', false],
    ];
    for (const [name, want] of cases) {
      const s = new LocalOfficeFiles();
      const f = fakeHandle({
        createWritable: async () => {
          throw Object.assign(new Error('x'), { name });
        },
      });
      s.stage(f.handle, 'a.docx', bytes(1));
      const t = s.take()!.token;
      expect(await s.writeBack(t, bytes(1)), name).toBe(want);
    }
  });

  it('staged は書き戻せるかを持つ(押した時点の知らせの言い分けに使う)', () => {
    const s = new LocalOfficeFiles();
    expect(s.stage(fakeHandle().handle, 'a.docx', bytes(1)).writable).toBe(true);
    expect(s.take()?.writable).toBe(true);
    expect(s.stage(fakeHandle({ createWritable: undefined }).handle, 'b.docx', bytes(1)).writable).toBe(false);
    expect(s.take()?.writable, '取り出した側で落ちている').toBe(false);
  });

  it('2 回保存すれば 2 回書く(開いている間ずっと使える)', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle();
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(1))).toBe(true);
    expect(await s.writeBack(t, bytes(2))).toBe(true);
    expect(f.written).toHaveLength(2);
  });
});

/**
 * 🔴 **session 限り**(`launched-files.ts` と同じ判断)。
 * ⚠ 保存すると「昔どこかで開いたファイル」への書込権を黙って持ち続けることになる。
 */
describe('寿命', () => {
  it('🔴 handle をどこにも保存していない(原文で見る)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/adapter/platform/office/local-office-files.ts', 'utf8');
    for (const sink of ['localStorage', 'indexedDB', 'sessionStorage', 'idb']) {
      expect(src, `handle を ${sink} へ保存している(同意の延命)`).not.toContain(sink);
    }
  });

  it('作り直せば何も残らない(読み直し = 紐づけが消える)', () => {
    const s = new LocalOfficeFiles();
    s.stage(fakeHandle().handle, 'a.docx', bytes(1));
    s.take();
    expect(new LocalOfficeFiles().nameOf('local:1'), '別の実体に前回の紐づけが残った').toBeNull();
  });

  it('🔴 読み込み直した側へ前回の合言葉を渡しても、別のファイルに当たらない(取り違えて書かない)', async () => {
    // 窓を残したまま PKC3 を読み込み直す流れ。連番だけだと、どちらも 1 件目なので同じ合言葉になる
    const first = new LocalOfficeFiles();
    const a = fakeHandle();
    first.stage(a.handle, 'A.docx', bytes(1));
    const tokenA = first.take()!.token;

    const second = new LocalOfficeFiles();
    const b = fakeHandle();
    second.stage(b.handle, 'B.docx', bytes(2));
    const tokenB = second.take()!.token;

    expect(tokenB, '読み込みをまたいで同じ合言葉になった').not.toBe(tokenA);
    expect(isLocalFileToken(tokenA)).toBe(true);
    expect(second.nameOf(tokenA), 'A の合言葉が B に当たった').toBeNull();
    expect(await second.writeBack(tokenA, bytes(9)), 'A の窓の保存が B へ書かれた').toBe(false);
    expect(b.written, 'B に書き込まれた').toHaveLength(0);
    expect(a.written).toHaveLength(0);
  });
});

/**
 * 🔴 **窓を作り直したとき、元のファイルの「いま」を送り直す**(O-1)。
 *
 * ⚠ 手元のファイルから開いた窓で保存すると、元のファイルは新しい中身に書き換わる。窓が止まって「読み込み直す」を押すと、
 *   開いた時の bytes を送り直す作りでは**古い版が開き、その上で保存すると新しい版を古い版で上書きする**。
 * 🔑 観測点は「読み直しの口が在るか」でなく、**作り直された窓に実際に届いた bytes**(本物の `OfficeWindow` を通す)。
 */
describe('窓の読み直しで、元のファイルの現在の中身が届く(O-1)', () => {
  /** 中身を差し替えられる偽の元ファイル。 */
  function fileHandle(initial: number[]) {
    let content = initial;
    let fail = false;
    const base = fakeHandle().handle;
    const handle: LaunchedHandle = {
      ...base,
      getFile: async () => {
        if (fail) throw new Error('NotFoundError');
        return { arrayBuffer: async () => new Uint8Array(content).buffer } as unknown as File;
      },
    };
    return { handle, set: (c: number[]) => { content = c; }, breakIt: () => { fail = true; } };
  }

  function bus() {
    interface Ch { onmessage: ((ev: MessageEvent) => void) | null; postMessage(d: unknown): void; close(): void }
    const chans: Ch[] = [];
    return {
      make: (): Ch => {
        const c: Ch = {
          onmessage: null,
          postMessage(d) {
            for (const o of chans) if (o !== c) queueMicrotask(() => o.onmessage?.({ data: structuredClone(d) } as MessageEvent));
          },
          close() {},
        };
        chans.push(c);
        return c;
      },
    };
  }
  const settle = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); };

  async function openAndCrash(f: ReturnType<typeof fileHandle>, afterOpen: () => void) {
    const b = bus();
    const files = new LocalOfficeFiles();
    files.stage(f.handle, 'F.docx', new Uint8Array([1, 1, 1]));
    const staged = files.take()!;
    const win = new OfficeWindow({ makeChannel: b.make, openWindow: () => {}, now: () => 100_000, baseUrl: 'http://x/' });
    const host = b.make();
    const got: number[][] = [];
    host.onmessage = (ev) => {
      const d = ev.data as { pkc3Office: string; payload: { bytes?: Uint8Array } };
      if (d.pkc3Office === 'document') got.push([...d.payload.bytes!]);
    };
    win.open({ name: staged.name, expectDocument: true });
    provideStagedLocal(win, files, staged);
    host.postMessage({ pkc3Office: 'ready-for-document', payload: {} });
    await settle();
    expect(got, '前提: 最初に開いた中身が届いている').toEqual([[1, 1, 1]]);
    // 窓の中で保存した → 元のファイルが新しい中身になった(or 読めなくなった)→ 窓が止まって読み込み直す
    afterOpen();
    host.postMessage({ pkc3Office: 'ready-for-document', payload: {} });
    await settle();
    return got;
  }

  it('🔴 作り直された窓には、開いた時ではなく「いま」の中身が届く', async () => {
    const f = fileHandle([1, 1, 1]);
    const got = await openAndCrash(f, () => f.set([2, 2, 2]));
    expect(got, '古い版を送り直した ── その上で保存すると新しい版を巻き戻す').toEqual([[1, 1, 1], [2, 2, 2]]);
  });

  it('🔴 読み直せなければ何も送らない(古い版を出さない)', async () => {
    const f = fileHandle([1, 1, 1]);
    const got = await openAndCrash(f, () => f.breakIt());
    expect(got).toEqual([[1, 1, 1]]);
  });

  it('reread: 控えのない合言葉 / getFile の無い handle / 空のファイルは null', async () => {
    const files = new LocalOfficeFiles();
    expect(await files.reread('local:none')).toBeNull();
    files.stage(fakeHandle().handle, 'a.docx', bytes(1));
    const st = files.take()!;
    expect(await files.reread(st.token), 'getFile が無い handle').toBeNull();
    const f = fileHandle([]);
    files.stage(f.handle, 'b.docx', bytes(1));
    const st2 = files.take()!;
    expect(await files.reread(st2.token), '空は送らない').toBeNull();
  });

  it('🔴 読み直しの口を添えて渡す(口が無いと窓が開いた時の bytes を抱える)', () => {
    const sent: unknown[][] = [];
    const spy = { provideDocument: (...a: unknown[]) => { sent.push(a); } };
    const files = new LocalOfficeFiles();
    const f = fileHandle([1]);
    files.stage(f.handle, 'a.docx', bytes(1));
    provideStagedLocal(spy as never, files, files.take()!);
    const args = sent[0]!;
    expect(typeof args[4], '読み直しの口が渡っていない').toBe('function');
    expect(args[3], '画像は渡さない(手元のファイルには無い)').toEqual([]);
  });
});
