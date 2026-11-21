import { describe, expect, it } from 'vitest';
import {
  alreadyImported,
  deviceOfFolderFile,
  folderFileNameOf,
  isSafeAssetFileName,
  memoKey,
  needsOwnWrite,
  phaseForPermission,
  planFolderFiles,
  SYNC_FOLDER_SETTLE_MS,
} from '../../../src/features/sync/sync-folder';
import { readDiffManifest, readDiffZip, writeDiffZip, type DiffNote } from '../../../src/features/sync/diff-file';
import { effectiveBaseline } from '../../../src/features/sync/sync-plan';
import { labelFp, labelKey, markKeyLid, isMarkKey, isNoteKey, pinFp, pinKey } from '../../../src/features/sync/sync-marks';

const A = '0123456789abcdef';
const B = 'fedcba9876543210';

describe('フォルダ同期の置き方(純関数)', () => {
  it('ファイル名: 端末 ID + .pkc3-diff.zip。クラウドの競合コピー・別の形の名前は対象外', () => {
    expect(folderFileNameOf(A)).toBe(`${A}.pkc3-diff.zip`);
    expect(deviceOfFolderFile(`${A}.pkc3-diff.zip`)).toBe(A);
    for (const bad of [`${A}.zip`, `${A} (1).pkc3-diff.zip`, 'x.pkc3-diff.zip', `${A.toUpperCase()}.pkc3-diff.zip`, `../${A}.pkc3-diff.zip`, '日本語.pkc3-diff.zip']) {
      expect(deviceOfFolderFile(bad), bad).toBeNull();
    }
  });
  it('添付の実体の名前は、フォルダの外へ出ない字種だけ', () => {
    expect(isSafeAssetFileName('ast-123_a.b')).toBe(true);
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x'.repeat(201), '日本語']) expect(isSafeAssetFileName(bad), bad).toBe(false);
  });
  it('planFolderFiles: 自分 / 書き込み途中 / 前回と同じ / 取り込み候補を分け、対象外の名前は見ない', () => {
    const now = 1_000_000;
    const old = now - SYNC_FOLDER_SETTLE_MS - 1;
    const files = [
      { name: folderFileNameOf(A), size: 1, lastModified: old },
      { name: folderFileNameOf(B), size: 5, lastModified: old },
      { name: '1111111111111111.pkc3-diff.zip', size: 5, lastModified: now - 10 },
      { name: '2222222222222222.pkc3-diff.zip', size: 7, lastModified: old },
      { name: 'メモ.txt', size: 7, lastModified: old },
    ];
    const memo = new Map([[folderFileNameOf(B), memoKey(files[1]!)]]);
    const out = planFolderFiles(files, A, memo, now);
    expect(out.map((x) => [x.device, x.kind])).toEqual([
      [A, 'own'],
      ['1111111111111111', 'settling'],
      ['2222222222222222', 'consider'],
      [B, 'unchanged'],
    ]);
    // 対照: 控えが変わっていれば(大きさ違い)候補に戻る
    const changed = planFolderFiles([{ ...files[1]!, size: 6 }], A, memo, now);
    expect(changed[0]!.kind).toBe('consider');
  });
  it('連番: 取り込み済みの最新以下は読まない / 新しければ読む / 記録が無ければ読む', () => {
    expect(alreadyImported(3, 3)).toBe(true);
    expect(alreadyImported(2, 3)).toBe(true);
    expect(alreadyImported(4, 3)).toBe(false);
    expect(alreadyImported(1, undefined)).toBe(false);
  });
  it('自分のファイルを書く必要: 無い / 控えに無い連番 / 要約が違う → 書く。要約が同じ → 書かない', () => {
    expect(needsOwnWrite(null, { 1: 'x' }, 'x')).toBe(true);
    expect(needsOwnWrite(2, { 1: 'x' }, 'x')).toBe(true);
    expect(needsOwnWrite(1, { 1: 'x' }, 'y')).toBe(true);
    expect(needsOwnWrite(1, { 1: 'x' }, 'x')).toBe(false);
  });
  it('許可の状態 → 次の状態(granted のみ再開 / prompt は許可待ち / それ以外は選び直し)', () => {
    expect(phaseForPermission('granted')).toBe('idle');
    expect(phaseForPermission('prompt')).toBe('needs-permission');
    expect(phaseForPermission('denied')).toBe('lost');
    expect(phaseForPermission(null)).toBe('lost');
  });
});

describe('印のキー(色ラベル・ピン留め)', () => {
  it('キー ↔ lid・種類の判定', () => {
    expect(labelKey('n1')).toBe('lbl:n1');
    expect(pinKey('n1')).toBe('pin:n1');
    expect(markKeyLid('lbl:n1')).toBe('n1');
    expect(markKeyLid('pin:x:y')).toBe('x:y');
    expect(markKeyLid('n1')).toBeNull();
    expect(isMarkKey('lbl:n1') && isMarkKey('pin:n1') && !isMarkKey('rel:a|b|c') && !isMarkKey('n1')).toBe(true);
    expect(isNoteKey('n1') && !isNoteKey('lbl:n1') && !isNoteKey('pin:n1') && !isNoteKey('rel:a|b|c')).toBe(true);
  });
  it('色が違えば指紋が違う・同じなら同じ・ピンは定数', () => {
    expect(labelFp(1)).toEqual(labelFp(1));
    expect(labelFp(1).content).not.toBe(labelFp(2).content);
    expect(pinFp()).toEqual(pinFp());
    expect(labelFp(1).content).not.toBe(pinFp().content);
  });
});

describe('effectiveBaseline: 相手が自分の見た版のまま(フォルダ同期で相手のファイルが先に在るとき)', () => {
  const V = { content: 'v0', place: 'p' };
  const L = { content: 'local', place: 'p' };
  it('こちらだけが変えた物は、相手の指紋が相手の記録と同じなら祖先にする(初回の競合にしない)/ 相手が変えていれば祖先にしない', () => {
    const peerBase = [{ key: 'a', c: 'v0', p: 'p' }];
    const local = [{ key: 'a', ...L }];
    const same = effectiveBaseline({}, peerBase, local, new Map([['a', V]]));
    expect(same.a).toEqual(V);
    const changed = effectiveBaseline({}, peerBase, local, new Map([['a', { content: 'remote', place: 'p' }]]));
    expect(changed.a).toBeUndefined();
    // 相手の指紋を渡さない(従来の呼び方)は従来どおり
    expect(effectiveBaseline({}, peerBase, local).a).toBeUndefined();
  });
});

describe('差分ファイル: 概要だけ読む・相手ごとの記録・途中までの zip', () => {
  const note: DiffNote = { lid: 'a', title: '日本語', archetype: 'text', parentLid: null, body: '本文' };
  async function build(peerBases?: Record<string, Array<{ key: string; c: string }>>): Promise<Blob> {
    const out = await writeDiffZip({
      manifest: { exported_at: '2026-11-21T00:00:00Z', device: A, seq: 4, cid: 'c-x', title: 'T', complete: true },
      notes: (async function* () {
        yield note;
      })(),
      relations: [],
      tombstones: [],
      fingerprints: [{ key: 'a', c: 'h' }],
      peerBase: [],
      ...(peerBases === undefined ? {} : { peerBases }),
      labels: [{ lid: 'a', color: 3 }],
      pins: ['a', 'a'],
      assets: () => [{ key: 'ast-1', mime: 'image/png', size: 3, hash: null }],
      getAssetBlob: async () => null,
      inlineAssets: false,
    });
    return out.blob;
  }
  it('readDiffManifest は概要だけ返し、読み書きの往復で色ラベル・ピン(重複は 1 つ)・相手ごとの記録が戻る。inlineAssets:false は実体を積まない', async () => {
    const zip = await build({ [B]: [{ key: 'a', c: 'v0' }] });
    const m = await readDiffManifest(zip);
    expect([m.device, m.seq, m.cid]).toEqual([A, 4, 'c-x']);
    const full = await readDiffZip(zip);
    expect(full.container.labels).toEqual([{ lid: 'a', color: 3 }]);
    expect(full.container.pins).toEqual(['a']);
    expect(full.container.peerBases?.[B]).toEqual([{ key: 'a', c: 'v0' }]);
    expect(full.container.assets.map((a) => a.key)).toEqual(['ast-1']); // 目録はある
    expect(full.assetSources.size).toBe(0); // 実体は積んでいない
    expect((await readDiffZip(await build())).container.peerBases).toBeNull(); // 無ければ null(段 2 のファイル)
  });
  it('途中までしか届いていない zip(半分・先頭だけ・空)は、概要も本体も読めず throw する(何も取り込まない)', async () => {
    const zip = await build();
    for (const cut of [Math.floor(zip.size / 2), 30, 0]) {
      const part = zip.slice(0, cut);
      await expect(readDiffManifest(part), `概要 ${cut}`).rejects.toThrow();
      await expect(readDiffZip(part), `本体 ${cut}`).rejects.toThrow();
    }
  });
  it('system 領域の lid の色ラベル・ピンは読む段階で捨てる(数は dropped)', async () => {
    const out = await writeDiffZip({
      manifest: { exported_at: '', device: A, seq: 1, cid: 'c', title: 'T', complete: true },
      notes: (async function* (): AsyncGenerator<DiffNote> {})(),
      relations: [],
      tombstones: [],
      fingerprints: [],
      peerBase: [],
      labels: [
        { lid: 'sys-messages', color: 2 },
        { lid: 'n1', color: 2 },
      ],
      pins: ['sys-jobs', 'n1'],
      assets: () => [],
      getAssetBlob: async () => null,
    });
    const r = await readDiffZip(out.blob);
    expect(r.container.labels).toEqual([{ lid: 'n1', color: 2 }]);
    expect(r.container.pins).toEqual(['n1']);
    expect(r.dropped.reserved).toBe(2);
  });
});
