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
  CHANGED_OUTSIDE_REOPEN_NOTE,
  DIFF_READ_LIMIT_BYTES,
  CHANGED_OUTSIDE_WRITE_BACK_NOTE,
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

/**
 * 🔴 **取り込んだ後にパソコン側で変わったことを、比べて言う**(#1264 §2 欠陥 1)。
 *
 * ⚠ 観測点は **偽 handle の `lastModified`** ── 進めたら「変わった」、進めなければ「変わっていない」
 *   (対照群を同じ場面に置く。置かないと「常に変わった」でも緑)。
 * ⚠ `getFile` を呼ぶのは**書き戻す直前**(`changedSince`)だけ。押し直しは、押した 1 件を呼び側が読み済み
 *   (`item.file`)なので、**ここでは足さない**(#1271)。
 */
describe('取り込んだ後に外で変わったか', () => {
  /** `lastModified` を後から進められる handle(本物の「外のエディタが直した」を真似る)。 */
  function movable(id: string, initial: number) {
    const state = { at: initial, gets: 0 };
    const h = fakeHandle(id, {
      getFile: () => {
        state.gets += 1;
        return Promise.resolve(new File(['x'], 'a.md', { lastModified: state.at }));
      },
    });
    return { h, state };
  }

  it('🔴 書き戻す直前: 時刻が進んでいれば true、進んでいなければ false(対照群)', async () => {
    const l = new LaunchedFiles();
    const { h, state } = movable('a', 1000);
    l.remember('n1', h, 'a.md', 1000);
    expect(await l.changedSince('n1'), '何も触っていないのに「変わった」').toBe(false);
    state.at = 2000; // 外のエディタが直した
    expect(await l.changedSince('n1'), '外で変わったのに言わない(書き戻すと消える)').toBe(true);
  });

  it('🔴 取り込み時の時刻を持たない記憶(添付・連絡先)は比べない ── getFile も呼ばない', async () => {
    const l = new LaunchedFiles();
    const { h, state } = movable('a', 1000);
    l.remember('n1', h, 'a.png'); // 時刻を渡さない
    state.at = 2000;
    expect(await l.changedSince('n1')).toBe(false);
    expect(state.gets, '時刻が無いのに getFile を呼んだ').toBe(0);
    expect(await l.changedSince('nope'), '記憶に無い lid').toBe(false);
  });

  it('🔴 読めない(getFile が投げる / 無い)ときは false ── 毎回脅さない', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a', { getFile: () => Promise.reject(new Error('gone')) }), 'a.md', 1000);
    l.remember('n2', fakeHandle('b'), 'b.md', 1000); // getFile を持たない
    expect(await l.changedSince('n1')).toBe(false);
    expect(await l.changedSince('n2')).toBe(false);
  });

  /**
   * 🔴 **書き戻す直前の読みは 1 回**(#1231 段②)── 「外で変わったか」と「今の中身」(差分の相手)を
   * **同じ `getFile()`** から採る。⚠ 2 回読むと、間に外で書かれたとき**時刻と中身が別の版**になる。
   */
  it('🔴 readCurrent: getFile 1 回で、変わったかと今の中身を返す', async () => {
    const l = new LaunchedFiles();
    const { h, state } = movable('a', 1000);
    l.remember('n1', h, 'a.md', 1000);
    const same = await l.readCurrent('n1');
    expect(same).toEqual({ changed: false, text: 'x' });
    expect(state.gets, 'getFile を 2 回以上呼んだ').toBe(1);
    state.at = 2000;
    expect(await l.readCurrent('n1'), '外で変わったのに changed が立たない').toEqual({ changed: true, text: 'x' });
    expect(state.gets).toBe(2);
  });

  it('🔴 readCurrent: 取り込み時の時刻が無い記憶は changed にしない(今の中身は返す)', async () => {
    const l = new LaunchedFiles();
    const { h } = movable('a', 1000);
    l.remember('n1', h, 'a.md'); // 時刻を渡さない
    expect(await l.readCurrent('n1')).toEqual({ changed: false, text: 'x' });
  });

  it('🔴 readCurrent: 読めない / getFile が無い / 記憶に無いなら null(差分なしで進める)', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a', { getFile: () => Promise.reject(new Error('gone')) }), 'a.md', 1000);
    l.remember('n2', fakeHandle('b'), 'b.md', 1000);
    expect(await l.readCurrent('n1')).toBeNull();
    expect(await l.readCurrent('n2')).toBeNull();
    expect(await l.readCurrent('nope')).toBeNull();
  });

  it('⚠ readCurrent: 時刻は読めたが中身だけ読めないとき、changed は返し text は null', async () => {
    const l = new LaunchedFiles();
    const file = { lastModified: 2000, size: 1, text: () => Promise.reject(new Error('io')) } as unknown as File;
    l.remember('n1', fakeHandle('a', { getFile: () => Promise.resolve(file) }), 'a.md', 1000);
    expect(await l.readCurrent('n1')).toEqual({ changed: true, text: null });
  });

  it('🔴 readCurrent: 大きすぎる file の中身は読まない(text を呼ばない。changed は返す)', async () => {
    const l = new LaunchedFiles();
    let texted = 0;
    const file = {
      lastModified: 2000,
      size: DIFF_READ_LIMIT_BYTES + 1,
      text: () => {
        texted += 1;
        return Promise.resolve('x');
      },
    } as unknown as File;
    l.remember('n1', fakeHandle('a', { getFile: () => Promise.resolve(file) }), 'a.md', 1000);
    // 🔴 大きすぎるときだけ `tooLarge: true`(読めなかったのと分ける。履歴の面が言う字を変える)
    expect(await l.readCurrent('n1')).toEqual({ changed: true, text: null, tooLarge: true });
    expect(await l.readForCompare('n1'), '大きすぎるのに null(読めなかった)と同じ扱い').toEqual({ tooLarge: true });
    expect(texted, '上限を超えるのに中身を読んだ').toBe(0);
    // 対照群: ちょうど上限なら読む
    const edge = { ...file, size: DIFF_READ_LIMIT_BYTES, text: () => Promise.resolve('y') } as unknown as File;
    l.remember('n2', fakeHandle('b', { getFile: () => Promise.resolve(edge) }), 'b.md', 1000);
    expect((await l.readCurrent('n2'))?.text).toBe('y');
    expect((await l.readCurrent('n2'))?.tooLarge, 'ちょうど上限なのに tooLarge').toBeUndefined();
    expect(await l.readForCompare('n2')).toBe('y');
  });

  it('🔴 readForCompare: 読めなかった / 結びついていない は null(tooLarge と分ける)', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a', { getFile: () => Promise.reject(new Error('gone')) }), 'a.md', 1000);
    expect(await l.readForCompare('n1')).toBeNull();
    expect(await l.readForCompare('nope')).toBeNull();
  });

  it('🔴 書き戻した後は、自分の書込を外の変更と読まない(憶え直す)', async () => {
    const l = new LaunchedFiles();
    const { h, state } = movable('a', 1000);
    l.remember('n1', h, 'a.md', 1000);
    state.at = 3000; // 自分の書込で時刻が動いた
    await l.refreshModified('n1');
    expect(l.modifiedOf('n1')).toBe(3000);
    expect(await l.changedSince('n1'), '自分の書込を「外で変わった」と言っている').toBe(false);
    state.at = 4000; // その後、本当に外で変わった
    expect(await l.changedSince('n1')).toBe(true);
  });

  it('🔴 押し直し: 取り込んだ時の時刻と違えば changed に入る。同じなら入らない(対照群)。getFile は呼ばない', async () => {
    const l = new LaunchedFiles();
    const { h, state } = movable('a', 1000);
    l.remember('n1', h, 'a.md', 1000);
    const press = (modified: number) => ({
      handle: fakeHandle('a'),
      file: new File(['x'], 'a.md', { lastModified: modified }),
    });
    const same = await splitAlreadyOpen([press(1000)], l, () => true);
    expect(same.reopened).toEqual(['n1']);
    expect(same.changed, '変わっていないのに changed').toEqual([]);
    const moved = await splitAlreadyOpen([press(2000)], l, () => true);
    expect(moved.reopened, '変わっていても前のノートを指す(取り込み直さない)').toEqual(['n1']);
    expect(moved.fresh).toEqual([]);
    expect(moved.changed, '外で変わったのに言わない').toEqual(['n1']);
    expect(state.gets, '押し直しの判定で getFile を呼んだ').toBe(0);
  });

  it('⚠ 取り込み時の時刻を持たない記憶は、押し直しでも changed にしない', async () => {
    const l = new LaunchedFiles();
    l.remember('n1', fakeHandle('a'), 'a.md');
    const r = await splitAlreadyOpen(
      [{ handle: fakeHandle('a'), file: new File(['x'], 'a.md', { lastModified: 9 }) }],
      l,
      () => true,
    );
    expect(r.changed).toEqual([]);
  });

  it('🔴 画面に出す字', () => {
    expect(CHANGED_OUTSIDE_WRITE_BACK_NOTE).toBe(
      'このファイルは取り込んだ後にパソコン側で変わっています。書き戻すと、その変更は消えます',
    );
    expect(CHANGED_OUTSIDE_REOPEN_NOTE).toBe(
      'このファイルは取り込んだ後にパソコン側で変わっています(PKC のノートは取り込んだ時の中身です)',
    );
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
