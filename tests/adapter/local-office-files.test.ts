/**
 * 🔴 **手元のファイルを Office で開き、元のファイルへ書き戻す**(#432)。
 *
 * ⚠ ここで守るのは 4 つ:①**控えは 1 件**(押したら違うほうが開く、を作らない)
 * ②**取り出したら空にする**(閉じたのに戻ってくる、を作らない)
 * ③**書けなかったら false を返す**(黙って「保存しました」と言わない)
 * ④**session 限り**(handle をどこにも保存しない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalOfficeFiles } from '../../src/adapter/platform/office/local-office-files';
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
    expect(await s.writeBack(t, bytes(1))).toBe(false);
  });

  it('🔴 許可が下りなければ false(勝手に書かない)', async () => {
    const s = new LocalOfficeFiles();
    const f = fakeHandle({
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'denied',
    });
    s.stage(f.handle, 'a.docx', bytes(1));
    const t = s.take()!.token;
    expect(await s.writeBack(t, bytes(1))).toBe(false);
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
    await expect(s.writeBack(t, bytes(1))).resolves.toBe(false);
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
});
