/** @vitest-environment happy-dom */
/**
 * 🔴 **画像に描き込む段取り**(#683 段③)。
 *
 * ⚠ 見るのは user がどう受け取るか:
 *   ①元は残る ②新しい添付が 1 件できる(名前・形)③元と同じフォルダに入る・読んでいたノートを退かさない
 *   ④本文に書けないときは窓に理由を出して**保存を預からない(線は窓に残る)**
 *   ⑤開けない種類・中身が無い・ポップアップ阻止は黙らず理由を出す ⑥同時に 2 つ作らない
 *   ⑦窓は押した瞬間に開く(読み込みを待たない)⑧開いている窓は開き直さず手前に出す。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createImageDrawer,
  IMAGE_DRAW_BUSY_TEXT,
  imageDrawPhaseBlockedText,
  IMAGE_DRAW_POPUP_BLOCKED_TEXT,
} from '../../src/adapter/ui/actions/image-draw';
import type {
  ImageDrawSaveResult,
  ImageDrawWindow,
  ImageDrawWindowDeps,
} from '../../src/adapter/platform/image-draw-window';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { AttachItem } from '../../src/adapter/ui/actions/attach';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: `${lid}`,
  archetype: 'attachment',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

type Place = { readonly parentLid: string | null; readonly keepSelection: boolean };
type AttachFn = (
  i: AttachItem,
  place: Place,
) => Promise<{ lid: string; assetKey: string; mime: string; hash: string | null } | null>;

function harness(
  over: { attach?: AttachFn; open?: boolean; readNull?: boolean; readGate?: Promise<void> } = {},
  stateOver: Partial<AppState> = {},
) {
  const dispatcher = new Dispatcher({
    ...initialState,
    phase: 'ready',
    entryMetas: new Map([
      ['img', meta('img')],
      ['memo', meta('memo')],
    ]),
    selectedLid: 'memo',
    ...stateOver,
  } as AppState);
  const attached: Array<{ item: AttachItem; place: Place }> = [];
  const notes: string[] = [];
  const noteOpens: string[] = [];
  const events: string[] = [];
  let saveFn: ((png: Blob) => Promise<ImageDrawSaveResult>) | null = null;
  const opened: ImageDrawWindowDeps[] = [];
  const wins: Array<{ closed: boolean; focus: ReturnType<typeof vi.fn>; failed: string[]; started: number }> = [];
  const drawer = createImageDrawer({
    dispatcher,
    readBlob: vi.fn(async () => {
      events.push('read');
      await over.readGate;
      return over.readNull === true ? null : new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
    }),
    parentOf: (lid) => (lid === 'img' ? 'folderA' : null),
    attach:
      over.attach ??
      (async (item, place) => {
        attached.push({ item, place });
        return { lid: 'new', assetKey: 'k2', mime: item.type, hash: 'h' };
      }),
    openWindow: (deps) => {
      events.push('open');
      opened.push(deps);
      if (over.open === false) return null;
      const w = { closed: false, focus: vi.fn(), failed: [] as string[], started: 0 };
      wins.push(w);
      const win: ImageDrawWindow = {
        get closed() {
          return w.closed;
        },
        focus: w.focus,
        close: () => {
          w.closed = true;
        },
        start: async (_blob, save) => {
          w.started += 1;
          saveFn = save;
        },
        fail: (m) => void w.failed.push(m),
      };
      return win;
    },
    notify: (t, openLid) => {
      notes.push(t);
      noteOpens.push(openLid);
    },
  });
  return { dispatcher, drawer, attached, notes, noteOpens, events, opened, wins, save: (b: Blob) => saveFn!(b) };
}

const png = (): Blob => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

describe('同じ画像を 2 つのノートに持つ(#1087)', () => {
  it('🔴 別のノートで押すと、別の窓を開く(前のノートの窓を出すだけにしない)', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    await h.drawer.run('k1', 'a.png', 'image/png', 'img2');
    expect(h.opened.map((o) => o.windowName)).toEqual(['pkc3-draw-k1-img', 'pkc3-draw-k1-img2']);
  });
  it('対照群: 同じノートで 2 度押すと、開いている窓を出すだけ', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.opened).toHaveLength(1);
  });
});

describe('保存', () => {
  it('🔴 新しい添付が 1 件できる ── 名前は 元 + (描き込み).png、形は PNG', async () => {
    const h = harness();
    await h.drawer.run('k1', '写真.jpg', 'image/jpeg', 'img');
    expect(h.opened[0]!.title).toBe('写真.jpg');
    expect(h.opened[0]!.windowName).toBe('pkc3-draw-k1-img');
    expect(h.attached).toHaveLength(0); // 窓を開いただけでは作らない(やめる = 何も作らない)
    expect(await h.save(png())).toEqual({ ok: true });
    expect(h.attached).toHaveLength(1);
    const { item } = h.attached[0]!;
    expect(item.name).toBe('写真 (描き込み).png');
    expect(item.type).toBe('image/png');
    expect(item.size).toBe(3);
  });

  it('🔴 元の画像と同じフォルダへ入れ、読んでいるノートも選択も動かさない', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    await h.save(png());
    // 元(img)の置き場は folderA ── 隣に出る
    expect(h.attached[0]!.place).toEqual({ parentLid: 'folderA', keepSelection: true });
  });

  it('元がルートにあれば、ルートへ入れる / 起点が分からなければルート', async () => {
    const a = harness();
    await a.drawer.run('k1', 'a.png', 'image/png', 'memo');
    await a.save(png());
    expect(a.attached[0]!.place.parentLid).toBeNull();
    const b = harness();
    await b.drawer.run('k1', 'a.png', 'image/png');
    await b.save(png());
    expect(b.attached[0]!.place.parentLid).toBeNull();
  });

  it('保存できたことを知らせる', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    await h.save(png());
    expect(h.notes).toEqual(['描き込んだ画像を保存しました:「a (描き込み).png」']);
    // 🔴 結果へ行く道:知らせの「開く」が、保存した添付(attach が返した lid)を指す
    expect(h.noteOpens).toEqual(['new']);
  });
});

describe('窓を開く', () => {
  it('🔴 窓は押した瞬間に開く ── 画像を読み終わるのを待たない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ readGate: gate });
    const p = h.drawer.run('k1', 'a.png', 'image/png', 'img');
    // 読み込みはまだ終わっていないが、窓は既に開いている(同期のうちに)
    expect(h.events).toEqual(['open', 'read']);
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0]!.started).toBe(0);
    release();
    await p;
    expect(h.wins[0]!.started).toBe(1);
  });

  it('🔴 開いている窓があれば、開き直さず手前に出す(2 枚目を作らない)', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.opened).toHaveLength(1);
    expect(h.wins[0]!.focus).toHaveBeenCalledTimes(1);
    expect(h.wins[0]!.started).toBe(1);
    // 別の画像なら別の窓
    await h.drawer.run('k2', 'b.png', 'image/png', 'img');
    expect(h.opened).toHaveLength(2);
  });

  it('閉じた窓なら、もう一度押せば開き直す', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    h.wins[0]!.closed = true;
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.opened).toHaveLength(2);
    expect(h.wins[0]!.focus).not.toHaveBeenCalled();
  });

  it('窓の onClosed で登録から外れる(閉じた窓を手前に出そうとしない)', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    h.opened[0]!.onClosed!();
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.opened).toHaveLength(2);
  });
});

describe('断る道 ── 黙って終わらない', () => {
  it('🔴 別の保存の最中(writeLock)は窓へ理由を返し、何も作らない(窓は開いたまま押し直せる)', async () => {
    const h = harness({}, { writeLock: { lid: 'memo' } } as Partial<AppState>);
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    const r = await h.save(png());
    expect(r).toEqual({ ok: false, message: IMAGE_DRAW_BUSY_TEXT });
    expect(IMAGE_DRAW_BUSY_TEXT).toBe(
      '別の保存の最中です。少し待ってから、もう一度「新しい画像として保存」を押してください(描いた線は残しています)',
    );
    expect(h.attached).toHaveLength(0);
  });

  it('🔴 保存に失敗して止まっている間は、錠ではなくその理由を言う(「別の保存の最中」と言い切らない)', async () => {
    const h = harness({}, { phase: 'error' } as Partial<AppState>);
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    const r = await h.save(png());
    expect(r).toEqual({ ok: false, message: imageDrawPhaseBlockedText('error') });
    expect(r.ok ? '' : r.message).not.toContain('別の保存の最中');
    expect(r.ok ? '' : r.message).toContain('もう一度「新しい画像として保存」を押してください');
    expect(h.attached).toHaveLength(0);
  });

  it('🔴 別のノートを編集している間でも保存できる ── 編集中のノートと開いている本文は動かない', async () => {
    const h = harness({}, {
      phase: 'editing',
      editingLid: 'memo',
      openBody: { lid: 'memo', body: 'まだ打っている' },
    } as unknown as Partial<AppState>);
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(await h.save(png())).toEqual({ ok: true });
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]!.place.keepSelection).toBe(true);
    const st = h.dispatcher.getState();
    expect(st.phase).toBe('editing');
    expect(st.openBody).toEqual({ lid: 'memo', body: 'まだ打っている' });
  });

  it('🔴 取り込みが落ちたら、先に出ていた具体的な理由を窓へ返す(汎用の字で塗り潰さない)', async () => {
    const holder: { d: Dispatcher | null } = { d: null };
    const h = harness({
      attach: async () => {
        holder.d!.dispatch({ type: 'OP_FAILED', error: '空き容量が足りません' });
        return null;
      },
    });
    holder.d = h.dispatcher;
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(await h.save(png())).toEqual({ ok: false, message: '空き容量が足りません' });
  });

  it('理由が分からない失敗でも、保存できなかったと窓に出す', async () => {
    const h = harness({ attach: async () => null });
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(await h.save(png())).toEqual({ ok: false, message: '保存できませんでした。' });
  });

  it('描けない種類は窓を開く前に断る', async () => {
    const h = harness();
    await h.drawer.run('k1', 'a.svg', 'image/svg+xml', 'img');
    expect(h.opened).toHaveLength(0);
    expect(h.dispatcher.getState().error).toContain('描き込めません');
  });

  it('中身が見つからないときは窓にその理由を出す', async () => {
    const h = harness({ readNull: true });
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.wins[0]!.failed.join('\n')).toContain('見つかりません');
    expect(h.wins[0]!.started).toBe(0);
  });

  it('🔴 ポップアップが止められたら、許可の出し方まで言う', async () => {
    const h = harness({ open: false });
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    expect(h.dispatcher.getState().error).toBe(IMAGE_DRAW_POPUP_BLOCKED_TEXT);
    expect(IMAGE_DRAW_POPUP_BLOCKED_TEXT).toContain('ポップアップの許可');
  });

  it('保存の最中にもう一度押されても、2 つ作らない', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const calls: AttachItem[] = [];
    const h = harness({
      attach: async (item) => {
        calls.push(item);
        await gate;
        return { lid: 'new', assetKey: 'k2', mime: item.type, hash: null };
      },
    });
    await h.drawer.run('k1', 'a.png', 'image/png', 'img');
    const first = h.save(png());
    const second = await h.save(png());
    expect(second.ok).toBe(false);
    release!();
    await first;
    expect(calls).toHaveLength(1);
  });
});
