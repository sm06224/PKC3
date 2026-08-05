/**
 * 🔴 **開いた md を元ファイルに紐づけたまま持つ**(2026-08-05、user 報告
 * 「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集プレビュー導線も
 * 存在しない」)。
 *
 * 直す前は受け口が `getFile()` だけ呼んで **handle を捨てて**いたので、
 *   ① 同じファイルを開くたびにノートが増え
 *   ② 直したものを元ファイルへ戻す道が無かった。
 *
 * ⚠ ここで守るのは「**取り違えない**」が最優先である ── 書き戻しは user の
 * ファイルを上書きするので、間違えた紐づけは**別のファイルを壊す**。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LaunchedFiles,
  splitAlreadyOpen,
  writeBackFile,
  type LaunchedHandle,
  type WritableLike,
} from '@adapter/platform/launched-files';

/** 実 handle の意味論を真似た fake(`isSameEntry` は**同一 identity** で答える)。 */
function fakeHandle(
  id: string,
  over: Partial<LaunchedHandle> = {},
): LaunchedHandle & { id: string } {
  return {
    id,
    kind: 'file',
    // ⚠ 本物は「同じファイルを指すか」を答える ── 名前ではなく実体で
    isSameEntry: (other) => Promise.resolve((other as { id?: string }).id === id),
    ...over,
  };
}

describe('LaunchedFiles', () => {
  it('lid ↔ ファイルを結び、名前と handle を返す', () => {
    const l = new LaunchedFiles();
    const h = fakeHandle('a');
    l.remember('n1', h, 'メモ.md');
    expect(l.nameOf('n1')).toBe('メモ.md');
    expect(l.handleOf('n1')).toBe(h);
    expect(l.nameOf('n2')).toBeNull();
    l.forget('n1');
    expect(l.handleOf('n1')).toBeNull();
  });

  it('🔴 同じファイルなら前の lid を返す(名前ではなく実体で照合)', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('inbox/メモ.md'), 'メモ.md');
    expect(await l.findLid(fakeHandle('inbox/メモ.md'))).toBe('n1');
    // ⚠ **同名の別ファイル**は別物 ── ここを名前で見ると、書き戻しで
    //    user の別のファイルを壊す
    expect(await l.findLid(fakeHandle('archive/メモ.md'))).toBeNull();
  });

  it('🔴 `isSameEntry` の無いブラウザでは null(増えるほうへ倒す)', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a'), 'a.md');
    const noCompare: LaunchedHandle = { kind: 'file' };
    // ⚠ 「照合できない = 同じ」と倒すと、無関係なノートを開いて上書きしうる
    expect(await l.findLid(noCompare)).toBeNull();
  });

  it('照合が例外を投げても落ちない(別物として続ける)', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a'), 'a.md');
    l.remember('n2', fakeHandle('b'), 'b.md');
    const angry = fakeHandle('b', {
      isSameEntry: (other) => {
        if ((other as { id?: string }).id === 'a') return Promise.reject(new Error('x'));
        return Promise.resolve(true);
      },
    });
    expect(await l.findLid(angry)).toBe('n2');
  });
});

describe('splitAlreadyOpen', () => {
  it('🔴 すでに開いているものは取り込み直さず、前のノートを指す', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a'), 'a.md');
    const items = [{ handle: fakeHandle('a') }, { handle: fakeHandle('b') }];
    const r = await splitAlreadyOpen(items, l, () => true);
    expect(r.reopened).toEqual(['n1']);
    expect(r.fresh).toHaveLength(1);
    expect((r.fresh[0]!.handle as { id: string }).id).toBe('b');
  });

  it('🔴 紐づけが残っていても entry が消えていれば取り込み直す', async () => {
    // ゴミ箱へ入れた後に同じ md を開いたら、また開けるべき
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a'), 'a.md');
    const r = await splitAlreadyOpen([{ handle: fakeHandle('a') }], l, () => false);
    expect(r.reopened).toEqual([]);
    expect(r.fresh).toHaveLength(1);
  });

  it('初回はすべて取り込む', async () => {
    const r = await splitAlreadyOpen(
      [{ handle: fakeHandle('a') }, { handle: fakeHandle('b') }],
      new LaunchedFiles(),
      () => true,
    );
    expect(r.fresh).toHaveLength(2);
    expect(r.reopened).toEqual([]);
  });
});

describe('writeBackFile', () => {
  const writable = (over: Partial<WritableLike> = {}) => {
    const wrote: string[] = [];
    const w: WritableLike & { closed: number; aborted: number } = {
      closed: 0,
      aborted: 0,
      write: async (d) => void wrote.push(d),
      close: async () => void (w.closed += 1),
      abort: async () => void (w.aborted += 1),
      ...over,
    };
    return { w, wrote };
  };

  it('🔴 許可を取ってから、本文をそのまま書いて閉じる', async () => {
    const { w, wrote } = writable();
    const query = vi.fn(() => Promise.resolve('granted'));
    const request = vi.fn(() => Promise.resolve('granted'));
    const h = fakeHandle('a', {
      queryPermission: query,
      requestPermission: request,
      createWritable: () => Promise.resolve(w),
    });
    const r = await writeBackFile(h, '# 本文\n');
    expect(r).toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith({ mode: 'readwrite' });
    // 既に granted なら聞き直さない(余計な確認を出さない)
    expect(request).not.toHaveBeenCalled();
    expect(wrote).toEqual(['# 本文\n']);
    expect(w.closed, '閉じていない(書込が確定しない)').toBe(1);
  });

  it('足りなければ許可を求め、granted なら書く', async () => {
    const { w, wrote } = writable();
    const request = vi.fn(() => Promise.resolve('granted'));
    const h = fakeHandle('a', {
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: request,
      createWritable: () => Promise.resolve(w),
    });
    expect(await writeBackFile(h, 'x')).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(wrote).toEqual(['x']);
  });

  it('🔴 断られたら書かない ── 理由を返す(黙って終えない)', async () => {
    const created = vi.fn();
    const h = fakeHandle('a', {
      queryPermission: () => Promise.resolve('denied'),
      requestPermission: () => Promise.resolve('denied'),
      createWritable: created as unknown as () => Promise<WritableLike>,
    });
    const r = await writeBackFile(h, 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('許可');
    expect(created, '断られたのに開いた(中身が切り詰められる)').not.toHaveBeenCalled();
  });

  it('🔴 書けないブラウザでは、何もせず理由を返す', async () => {
    const r = await writeBackFile(fakeHandle('a'), 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('対応していません');
  });

  it('🔴 書込の途中で失敗したら**必ず後始末する**(切り詰めたまま残さない)', async () => {
    const { w } = writable({ write: () => Promise.reject(new Error('disk full')) });
    const h = fakeHandle('a', {
      queryPermission: () => Promise.resolve('granted'),
      createWritable: () => Promise.resolve(w),
    });
    const r = await writeBackFile(h, 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('disk full');
    expect(w.aborted, 'abort していない').toBe(1);
  });

  it('abort が無ければ close で後始末する', async () => {
    const { w } = writable({ write: () => Promise.reject(new Error('boom')), abort: undefined });
    const h = fakeHandle('a', {
      queryPermission: () => Promise.resolve('granted'),
      createWritable: () => Promise.resolve(w),
    });
    expect((await writeBackFile(h, 'x')).ok).toBe(false);
    expect(w.closed).toBe(1);
  });

  it('開けなかった理由を返す', async () => {
    const h = fakeHandle('a', {
      queryPermission: () => Promise.resolve('granted'),
      createWritable: () => Promise.reject(new Error('locked')),
    });
    const r = await writeBackFile(h, 'x');
    expect(r.ok === false && r.reason).toContain('locked');
  });

  it('許可の問い合わせ自体が投げても、理由つきで終わる', async () => {
    const h = fakeHandle('a', {
      queryPermission: () => Promise.reject(new Error('nope')),
      createWritable: () => Promise.resolve(writable().w),
    });
    const r = await writeBackFile(h, 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('nope');
  });
});
