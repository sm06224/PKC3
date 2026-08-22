/**
 * 添付取込(P4a)の unit: File → Blob 直 put + meta 同時書き + entry 作成。
 * fake deps で put/list を記録し、dedupe / quota / mime fallback の縁を pin。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { attachFiles, resolveMime, type AttachDeps } from '../../src/adapter/ui/actions/attach';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';
import { stubRevisionOps } from '../helpers/revision-stub';

function harness(estimate?: AttachDeps['estimate']) {
  const putBlobs: Array<{ key: string; size: number }> = [];
  const metas: Array<{ key: string; mime: string; size: number; hash: string | null }> =
    [];
  const deps: AttachDeps = {
    putBlob: async (key, blob) => {
      putBlobs.push({ key, size: blob.size });
    },
    putMeta: async (m) => {
      metas.push(m);
    },
    listMetas: async () => [...metas], // 実装内部の push と共有しない(実 API 同様に copy)
    estimate,
  };
  const d = new Dispatcher();
  const persisted: Array<{ lid: string; body: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => null,
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push({ lid: e.lid, body: e.body });
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { d, deps, putBlobs, metas, persisted };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('attachFiles (P4a intake)', () => {
  it('Blob 直 put + meta(hash/size 同時)+ 非編集 entry 作成', async () => {
    const { d, deps, putBlobs, metas } = harness();
    await attachFiles(d, deps, [new File(['hello bytes'], 'note.txt', { type: 'text/plain' })]);
    await tick();

    expect(putBlobs).toHaveLength(1);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ mime: 'text/plain', size: 11 });
    expect(metas[0]!.hash).toMatch(/^[0-9a-f]{64}$/); // put と同時に SHA-256 が書かれる

    const s = d.getState();
    expect(s.phase).toBe('ready'); // editor に入らない(silent attach)
    expect(s.freshLid).toBeNull(); // fresh 掃除の対象外
    const meta = [...s.entryMetas.values()][0]!;
    expect(meta.archetype).toBe('attachment');
    expect(meta.title).toBe('note.txt');
    expect(s.selectedLid).toBe(meta.lid);
    // body は frontmatter メタ(JSON body を作らない)
    const att = readAttachmentMeta(s.openBody!.body);
    expect(att).toMatchObject({ name: 'note.txt', mime: 'text/plain', size: 11 });
    expect(att.assetKey).toBe(putBlobs[0]!.key);
  });

  it('同一 bytes(hash+size 一致)は既存 asset を再利用 ── put しない', async () => {
    const { d, deps, putBlobs, persisted } = harness();
    const bytes = 'same content';
    await attachFiles(d, deps, [new File([bytes], 'a.txt', { type: 'text/plain' })]);
    await attachFiles(d, deps, [new File([bytes], 'b.txt', { type: 'text/plain' })]);
    await tick();

    expect(putBlobs).toHaveLength(1); // 2 回目は bytes を書かない
    expect(persisted).toHaveLength(2); // entry は 2 つ
    const keys = persisted.map((e) => readAttachmentMeta(e.body).assetKey);
    expect(keys[0]).toBe(keys[1]); // 両 entry が同じ asset_key を参照
    expect(d.getState().entryMetas.size).toBe(2);
  });

  it('quota 不足は可視エラーで file 単位 skip(batch は続行)', async () => {
    const { d, deps, putBlobs } = harness(async () => ({ usage: 90, quota: 100 }));
    await attachFiles(d, deps, [new File(['0123456789'], 'big.bin', { type: '' })]);
    expect(putBlobs).toHaveLength(0);
    expect(d.getState().error).toMatch(/空き容量/);
    expect(d.getState().phase).toBe('ready'); // 非致命
  });

  it('編集中(phase!==ready)は put 前に可視ブロック ── bytes も entry も作らない', async () => {
    const { d, deps, putBlobs, metas } = harness();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'lid-editing', title: 'draft' });
    expect(d.getState().phase).toBe('editing');

    await attachFiles(d, deps, [new File(['x'], 'late.txt', { type: 'text/plain' })]);
    await tick();

    // put の前に止まる ── orphan asset(bytes だけ書かれ entry 黙殺)を作らない
    expect(putBlobs).toHaveLength(0);
    expect(metas).toHaveLength(0);
    expect(d.getState().entryMetas.size).toBe(1); // draft entry のみ、添付 entry は増えない
    expect(d.getState().error).toMatch(/編集を終了/); // 無言拒否にしない(可視)
    expect(d.getState().phase).toBe('editing'); // draft は無傷
  });

  it('mime fallback: file.type 空は拡張子から解決(PKC2 の欠落 hack を作らない)', () => {
    expect(resolveMime('doc.md', '')).toBe('text/markdown');
    expect(resolveMime('img.PNG', '')).toBe('image/png');
    expect(resolveMime('unknown.zzz', '')).toBe('application/octet-stream');
    expect(resolveMime('x.md', 'text/plain')).toBe('text/plain'); // 宣言優先
  });
});
