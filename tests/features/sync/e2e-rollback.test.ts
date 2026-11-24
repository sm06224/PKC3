/** @vitest-environment node */
/**
 * 🔴 **巻き戻し(古い暗号文の差し戻し)の拒否と、同期の記録の互換**(#2000 段 4b-d)。
 *
 * 守る主張:
 * 1. 取り込み済みの最大の連番より**小さい**連番は拒否 / **同じ連番で中身(版)が違う**物も拒否 / 大きい連番・初めての相手は受ける
 * 2. 連番は下がらない(記録の更新は最大を保つ)
 * 3. 記録(`peerSeq`)は normalize を生き残り、壊れた欄は捨てる
 * 4. 🔴 **旧い版の `normalizeFolderRecord`(`peerSeq` を知らない)がこの記録を読んでも壊れない**(旧ビルドは新しい欄を無視する)
 * 5. 名前の判定: 暗号化の名前は平文の名前と別 / 平文でも暗号化でも同じ端末の名前として読める / 競合コピーは読まない
 */
import { describe, expect, it } from 'vitest';
import {
  checkPeerSeq,
  chooseRoundFiles,
  deviceOfFileName,
  emptyFolderRecord,
  encFileName,
  folderFileName,
  isEncFileName,
  normalizeFolderRecord,
  notePeerSeq,
  type FolderFile,
} from '../../../src/features/sync/sync-folder';

const A = '0123456789abcdef';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';

describe('巻き戻しの拒否', () => {
  const file = { size: 100, mtime: 5, version: '"e1"' };
  it('記録が無い相手は受ける。受けたら記録する', () => {
    const rec = emptyFolderRecord();
    expect(checkPeerSeq(rec, B, 3, file)).toBe('ok');
    notePeerSeq(rec, B, 3, file);
    expect(rec.peerSeq[B]).toEqual({ seq: 3, size: 100, mtime: 5, version: '"e1"' });
  });
  it('🔴 小さい連番は拒否 / 同じ連番で版が違えば拒否 / 同じ連番で同じ版・大きい連番は受ける', () => {
    const rec = emptyFolderRecord();
    notePeerSeq(rec, B, 5, file);
    expect(checkPeerSeq(rec, B, 4, file)).toBe('rollback');
    expect(checkPeerSeq(rec, B, 0, { size: 1, mtime: 1, version: '"zz"' })).toBe('rollback');
    expect(checkPeerSeq(rec, B, 5, { ...file, version: '"e2"' })).toBe('replaced');
    expect(checkPeerSeq(rec, B, 5, file)).toBe('ok');
    expect(checkPeerSeq(rec, B, 6, { ...file, version: '"e9"' })).toBe('ok');
    // 版の無い保管先(フォルダ)は大きさ + 更新日時で見る
    const folderRec = emptyFolderRecord();
    notePeerSeq(folderRec, B, 5, { size: 10, mtime: 1 });
    expect(checkPeerSeq(folderRec, B, 5, { size: 10, mtime: 2 })).toBe('replaced');
    expect(checkPeerSeq(folderRec, B, 5, { size: 10, mtime: 1 })).toBe('ok');
    // 相手ごとに別(B の記録が C を縛らない)
    expect(checkPeerSeq(rec, C, 1, file)).toBe('ok');
  });
  it('記録は下がらない', () => {
    const rec = emptyFolderRecord();
    notePeerSeq(rec, B, 9, file);
    notePeerSeq(rec, B, 2, { size: 1, mtime: 1 });
    expect(rec.peerSeq[B]!.seq).toBe(9);
  });
});

describe('記録の互換', () => {
  it('peerSeq は normalize を生き残る / 壊れた欄は捨てる', () => {
    const rec = emptyFolderRecord();
    notePeerSeq(rec, B, 7, { size: 3, mtime: 4, version: '"v"' });
    const round = normalizeFolderRecord(JSON.parse(JSON.stringify(rec)));
    expect(round.peerSeq).toEqual(rec.peerSeq);
    const dirty = normalizeFolderRecord({
      peerSeq: { [B]: { seq: -1, size: 1, mtime: 1 }, [C]: { seq: 1.5, size: 1, mtime: 1 }, nothex: { seq: 1, size: 1, mtime: 1 }, [A]: { seq: 2, size: 'x', mtime: 1 }, ok0: 1 },
    });
    expect(dirty.peerSeq).toEqual({});
  });

  /**
   * 旧ビルドの `normalizeFolderRecord`(段 4a 時点の写し)。🔴 `peerSeq` を知らない ── 知っている欄(seen / lastKey / want)だけを読む。
   * 新ビルドが書いた記録(`peerSeq` 入り)を旧ビルドが読んでも、例外にならず、旧い欄は元のまま読めることを固定する。
   */
  function oldNormalize(v: unknown): { seen: Record<string, unknown>; lastKey: string | null; want: string[] } {
    const out = { seen: {} as Record<string, unknown>, lastKey: null as string | null, want: [] as string[] };
    if (typeof v !== 'object' || v === null) return out;
    const o = v as Record<string, unknown>;
    if (typeof o.lastKey === 'string') out.lastKey = o.lastKey;
    if (Array.isArray(o.want)) out.want = o.want.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x));
    if (typeof o.seen === 'object' && o.seen !== null) {
      for (const [name, s] of Object.entries(o.seen as Record<string, unknown>)) {
        if (!/^pkc3-[0-9a-f]{16}\.pkc3-diff\.zip$/.test(name) || typeof s !== 'object' || s === null) continue;
        const r = s as Record<string, unknown>;
        if (typeof r.size !== 'number' || typeof r.mtime !== 'number') continue;
        out.seen[name] = { size: r.size, mtime: r.mtime, ...(typeof r.version === 'string' ? { version: r.version } : {}), want: Array.isArray(r.want) ? r.want : [] };
      }
    }
    return out;
  }

  it('🔴 旧い版の normalize が新しい記録(peerSeq 入り・暗号化の名前入り)を読んでも壊れず、旧い欄はそのまま読める', () => {
    const rec = emptyFolderRecord();
    rec.lastKey = 'K';
    rec.want = [B];
    rec.seen[folderFileName(B)] = { size: 1, mtime: 2, version: '"x"', want: [A] };
    rec.seen[encFileName(C)] = { size: 5, mtime: 6, want: [] };
    notePeerSeq(rec, B, 4, { size: 1, mtime: 2 });
    const stored = JSON.parse(JSON.stringify(rec)) as unknown;
    expect(Object.keys(stored as object), '空振り防止: 新しい欄が実際に書かれている').toContain('peerSeq');
    const old = oldNormalize(stored);
    expect(old.lastKey).toBe('K');
    expect(old.want).toEqual([B]);
    expect(old.seen[folderFileName(B)]).toMatchObject({ size: 1, mtime: 2, version: '"x"' });
    // 旧ビルドは暗号化の名前を知らない ── 捨てる(読み直すだけ。壊れない)
    expect(Object.keys(old.seen)).toEqual([folderFileName(B)]);
    expect(Object.keys(old)).not.toContain('peerSeq');
  });
});

describe('名前', () => {
  it('暗号化の名前は平文の名前に .enc を足した物 / どちらも同じ端末 / 見分けは isEncFileName', () => {
    expect(encFileName(A)).toBe(`pkc3-${A}.pkc3-diff.zip.enc`);
    expect(deviceOfFileName(folderFileName(A))).toBe(A);
    expect(deviceOfFileName(encFileName(A))).toBe(A);
    expect(isEncFileName(encFileName(A))).toBe(true);
    expect(isEncFileName(folderFileName(A))).toBe(false);
    for (const bad of [`pkc3-${A}.pkc3-diff.zip.enc.enc`, `pkc3-${A}.pkc3-diff.enc`, `pkc3-${A.toUpperCase()}.pkc3-diff.zip.enc`, `pkc3-${A} (1).pkc3-diff.zip.enc`, 'keyring.json', `${A}.enc`]) {
      expect(deviceOfFileName(bad), bad).toBeNull();
      expect(isEncFileName(bad), bad).toBe(false);
    }
  });

  const f = (name: string): FolderFile => ({ name, size: 1, mtime: 1 });
  it('暗号化している: 暗号化を優先 / 平文だけの相手は読んだうえで案内 / 自分の平文は片付け対象', () => {
    const r = chooseRoundFiles([f(folderFileName(A)), f(encFileName(A)), f(folderFileName(B)), f(encFileName(C)), f(folderFileName(C))], A, true);
    expect(r.files.map((x) => x.name)).toEqual([encFileName(A), folderFileName(B), encFileName(C)]);
    expect(r.ownCounterpart).toBe(folderFileName(A));
    expect(r.peersNeedEnc).toEqual([B]);
    expect(r.peersEncOnly).toEqual([]);
  });
  it('暗号化していない: 平文だけ見る / 暗号化だけの相手は読めない(案内)/ 自分の暗号化は片付け対象', () => {
    const r = chooseRoundFiles([f(folderFileName(A)), f(encFileName(A)), f(folderFileName(B)), f(encFileName(C))], A, false);
    expect(r.files.map((x) => x.name)).toEqual([folderFileName(A), folderFileName(B)]);
    expect(r.ownCounterpart).toBe(encFileName(A));
    expect(r.peersEncOnly).toEqual([C]);
    expect(r.peersNeedEnc).toEqual([]);
  });
});
