/** @vitest-environment node */
/**
 * 🔴 **Office のタイルを押したとき、保存していない文書の控えを戻す口**(台帳 #1852 束 A1。依頼 367 A)。
 *
 * 見るのは:
 * 1. 手元のファイル: 控えが合えば添付と同じ確認 → 「一時保存した内容」で開く(合言葉は控えたファイルのまま = 保存は元のファイルへ)
 * 2. 「保存済みの版」を選べば控えを消して普通に開く / 「やめる」は何も開かず、控えたファイルも控えも残す
 * 3. 控えたファイルが無いとき、持ち主の居ない控えを一覧にする(開く / 開かずに / すべて消して / やめる)
 * 4. 窓が開いていそうなときは訊かない(窓が自分で確かめる)/ 控えが無ければ今までどおり同期で開く
 * 5. 読めない・確認が出せないときは開けなくしない
 */
import { describe, expect, it, vi } from 'vitest';
import { openOfficeTile, restoredName, type OfficeTileDeps } from '../../src/adapter/platform/office/office-tile-open';
import { LocalOfficeFiles } from '../../src/adapter/platform/office/local-office-files';
import {
  SHADOW_GONE_LIST_NOTICE,
  SHADOW_GONE_NOTICE,
  SHADOW_OPENED_LOCAL_NOTICE,
  SHADOW_OPENED_UNLINKED_NOTICE,
  SHADOW_UNTITLED,
} from '../../src/features/office/office-shadow';
import type { OrphanShadow } from '../../src/adapter/platform/office/office-shadow-shelf';
import type { LaunchedHandle } from '../../src/adapter/platform/launched-files';

const handle = { kind: 'file', createWritable: async () => ({ write: async () => {}, close: async () => {} }) } as unknown as LaunchedHandle;
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

interface Rig {
  deps: OfficeTileDeps;
  local: LocalOfficeFiles;
  calls: string[];
  provided: { name: string; bytes: Uint8Array; token: string; fromShadow: boolean; refresh: unknown; originSize: number | null }[];
  notices: string[];
  restored: string[];
  discarded: string[];
}

function rig(o: {
  alive?: boolean;
  localShadow?: OrphanShadow | null;
  orphans?: OrphanShadow[];
  shadowBytes?: Uint8Array | null;
  askLocal?: () => Promise<'shadow' | 'saved' | null>;
  askList?: () => Promise<unknown>;
  staged?: { name: string; bytes: Uint8Array; modifiedAt: number | null } | null;
}): Rig {
  const local = new LocalOfficeFiles();
  if (o.staged) local.stage(handle, o.staged.name, o.staged.bytes, o.staged.modifiedAt);
  const r: Rig = { deps: null as never, local, calls: [], provided: [], notices: [], restored: [], discarded: [] };
  const bytes = o.shadowBytes === undefined ? new Uint8Array([9, 9, 9, 9]) : o.shadowBytes;
  r.deps = {
    officeWindow: {
      isProbablyOpen: () => o.alive === true,
      open: (opts: { name?: string; expectDocument?: boolean }) => {
        r.calls.push(`open:${opts.name ?? ''}`);
        return { kind: 'opened' } as const;
      },
      provideDocument: (name: string, b: Uint8Array, token = '', ...rest: unknown[]) => {
        // 引数: (name, bytes, token, images, refresh, fromShadow, originSize)
        r.provided.push({
          name,
          bytes: b,
          token,
          fromShadow: rest[2] === true,
          refresh: rest[1] ?? null,
          originSize: typeof rest[3] === 'number' ? rest[3] : null,
        });
      },
    } as never,
    local,
    shadows: {
      mayHaveLocal: () => o.localShadow != null,
      findLocal: async () => o.localShadow ?? null,
      orphans: () => o.orphans ?? [],
      readById: async () => bytes as Uint8Array<ArrayBuffer> | null,
      discardById: async (id: string) => { r.discarded.push(id); },
    },
    askLocal: vi.fn(o.askLocal ?? (async () => 'shadow' as const)),
    askList: vi.fn((o.askList ?? (async () => null)) as never),
    openPlain: () => { r.calls.push('plain'); },
    notify: (t) => { r.notices.push(t); },
    afterRestore: (id) => { r.restored.push(id); },
  };
  return r;
}

const SH: OrphanShadow = { id: 'w-A', at: 5000, ext: 'docx', docName: '報告.docx', size: 100 };
const STAGED = { name: '報告.docx', bytes: new Uint8Array(100), modifiedAt: 1000 };

describe('手元のファイルの控え', () => {
  it('🔴 「一時保存した内容で開く」: 控えの bytes を、控えたファイルの合言葉で渡す(保存は元のファイルへ戻る)。控えは戻した後に消す印を預ける', async () => {
    const r = rig({ localShadow: SH, staged: STAGED });
    expect(openOfficeTile(r.deps)).toBe(true);
    await tick();
    expect(r.calls).toEqual(['open:報告.docx']);
    expect(r.provided).toHaveLength(1);
    const p = r.provided[0]!;
    expect(Array.from(p.bytes)).toEqual([9, 9, 9, 9]);
    expect(p.fromShadow, '窓が「保存していない変更あり」で開かない').toBe(true);
    expect(p.token.startsWith('local:'), '元のファイルに結ばれていない').toBe(true);
    expect(typeof p.refresh).toBe('function');
    expect(p.originSize, '元のファイルの大きさを窓へ持たせていない').toBe(100);
    expect(r.notices).toEqual([SHADOW_OPENED_LOCAL_NOTICE]);
    expect(r.restored).toEqual(['w-A']);
    expect(r.discarded, '戻した控えをすぐ消した').toEqual([]);
    expect(r.local.peek(), '取り出されていない').toBeNull();
  });

  it('「保存済みの版で開く」: 控えを消して、今までどおり開く', async () => {
    const r = rig({ localShadow: SH, staged: STAGED, askLocal: async () => 'saved' });
    openOfficeTile(r.deps);
    await tick();
    expect(r.discarded).toEqual(['w-A']);
    expect(r.calls).toEqual(['plain']);
    expect(r.provided).toEqual([]);
  });

  it('🔴 「やめる」: 何も開かず、控えも控えたファイルも残す(もう一度押せる)', async () => {
    const r = rig({ localShadow: SH, staged: STAGED, askLocal: async () => null });
    openOfficeTile(r.deps);
    await tick();
    expect(r.calls).toEqual([]);
    expect(r.discarded).toEqual([]);
    expect(r.local.peek(), '控えたファイルを失った').not.toBeNull();
  });

  it('確認を出せなかった / 控えが読めなかったときは、開けなくしない(控えは消さない)', async () => {
    const a = rig({ localShadow: SH, staged: STAGED, askLocal: async () => { throw new Error('x'); } });
    openOfficeTile(a.deps);
    await tick();
    expect(a.calls).toEqual(['plain']);
    expect(a.discarded).toEqual([]);

    const b = rig({ localShadow: SH, staged: STAGED, shadowBytes: null });
    openOfficeTile(b.deps);
    await tick();
    expect(b.notices).toEqual([SHADOW_GONE_NOTICE]);
    expect(b.calls).toEqual(['plain']);
    expect(b.provided).toEqual([]);
  });

  it('同期の見立てが外れた(findLocal が null)なら、確認を出さずに普通に開く', async () => {
    const r = rig({ localShadow: null, staged: STAGED });
    // mayHaveLocal は偽 → 同期で開く(確認の道に入らない)
    expect(openOfficeTile(r.deps)).toBe(false);
    expect(r.calls).toEqual(['plain']);
    expect(r.deps.askLocal).not.toHaveBeenCalled();
  });
});

describe('保存していない文書の一覧', () => {
  const O1: OrphanShadow = { id: 'w-1', at: 9000, ext: 'docx', docName: '議事録.docx', size: 10 };
  const O2: OrphanShadow = { id: 'w-2', at: 8000, ext: 'odt', docName: '', size: 20 };

  it('🔴 選んだ文書を、合言葉なし(= 保存すると新しい添付のノート)で開く。名前が無ければ呼び名 + 控えの拡張子', async () => {
    const r = rig({ orphans: [O1, O2], askList: async () => ({ kind: 'open', id: 'w-2' }) });
    expect(openOfficeTile(r.deps)).toBe(true);
    await tick();
    expect(r.calls).toEqual([`open:${SHADOW_UNTITLED}.odt`]);
    expect(r.provided[0]).toMatchObject({ name: `${SHADOW_UNTITLED}.odt`, token: '', fromShadow: true, originSize: 20 });
    expect(r.notices).toEqual([SHADOW_OPENED_UNLINKED_NOTICE]);
    expect(r.restored).toEqual(['w-2']);
  });

  it('「開かずに」は控えを残してスタート画面を開く / 「すべて消して」は全部消してから開く', async () => {
    const a = rig({ orphans: [O1, O2], askList: async () => ({ kind: 'skip' }) });
    openOfficeTile(a.deps);
    await tick();
    expect(a.calls).toEqual(['plain']);
    expect(a.discarded).toEqual([]);

    const b = rig({ orphans: [O1, O2], askList: async () => ({ kind: 'erase' }) });
    openOfficeTile(b.deps);
    await tick();
    expect(b.discarded).toEqual(['w-1', 'w-2']);
    expect(b.calls).toEqual(['plain']);
  });

  it('🔴 「やめる」は何もしない(控えを消さず、窓も開かない)', async () => {
    const r = rig({ orphans: [O1], askList: async () => null });
    openOfficeTile(r.deps);
    await tick();
    expect(r.calls).toEqual([]);
    expect(r.discarded).toEqual([]);
  });

  it('選んだ控えが読めなかったら、言ってスタート画面を開く。確認が出せなければそのまま開く', async () => {
    const a = rig({ orphans: [O1], askList: async () => ({ kind: 'open', id: 'w-1' }), shadowBytes: null });
    openOfficeTile(a.deps);
    await tick();
    expect(a.notices).toEqual([SHADOW_GONE_LIST_NOTICE]);
    expect(a.calls).toEqual(['plain']);

    const b = rig({ orphans: [O1], askList: async () => { throw new Error('x'); } });
    openOfficeTile(b.deps);
    await tick();
    expect(b.calls).toEqual(['plain']);
  });
});

describe('訊かない条件', () => {
  it('🔴 窓が開いていそうなら、控えがあっても訊かない(窓が自分で確かめる / 書いている最中の棚を並べない)', () => {
    const a = rig({ alive: true, localShadow: SH, staged: STAGED });
    expect(openOfficeTile(a.deps)).toBe(false);
    expect(a.calls).toEqual(['plain']);
    const b = rig({ alive: true, orphans: [SH] });
    expect(openOfficeTile(b.deps)).toBe(false);
    expect(b.calls).toEqual(['plain']);
    expect(b.deps.askList).not.toHaveBeenCalled();
  });

  it('控えが無ければ今までどおり同期で開く(ポップアップ遮断に当たらない)', () => {
    const r = rig({});
    expect(openOfficeTile(r.deps)).toBe(false);
    expect(r.calls).toEqual(['plain']);
  });

  it('手元のファイルを控えているときは、一覧ではなくそのファイルの確認だけ(別の文書を並べて取り違えない)', () => {
    const r = rig({ orphans: [SH], staged: STAGED, localShadow: null });
    expect(openOfficeTile(r.deps)).toBe(false);
    expect(r.deps.askList).not.toHaveBeenCalled();
  });
});

describe('restoredName', () => {
  it('控えの拡張子に合わせる。名前が無ければ呼び名', () => {
    expect(restoredName('議事録.docx', 'docx')).toBe('議事録.docx');
    expect(restoredName('報告.doc', 'docx')).toBe('報告.docx');
    expect(restoredName('拡張子なし', 'odt')).toBe('拡張子なし.odt');
    expect(restoredName('', 'docx')).toBe(`${SHADOW_UNTITLED}.docx`);
  });
});
