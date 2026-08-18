/** @vitest-environment happy-dom */
/**
 * asset GC(P4b)の orchestration pin。実 sqlite の substring 走査は
 * store probe(nightly)が検定する ── ここは候補の和集合 / orphan 判定 /
 * 削除順(blob → meta)/ 部分失敗の隔離を固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  findOrphanAssets,
  purgeAssets,
  purgeBlockReason,
  runExplicitPurge,
  type AssetGcPorts,
  type PurgeFlowDeps,
} from '../../src/adapter/platform/storage/asset-gc';
import { AssetBlobStore } from '../../src/adapter/platform/storage/asset-blob-store';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function fakePorts(over: Partial<AssetGcPorts> = {}) {
  const calls: string[] = [];
  const ports: AssetGcPorts = {
    listMetas: async () => [
      { key: 'k-ref', size: 10 },
      { key: 'k-orphan-meta', size: 20 },
    ],
    // k-orphan-meta は blob 側に無い(meta だけの dangling)、
    // k-orphan-blob は meta 側に無い(bytes だけの dangling)
    listBlobKeys: async () => ['k-ref', 'k-orphan-blob'],
    scanReferenced: async (candidates) => {
      calls.push(`scan:${[...candidates].sort().join(',')}`);
      return ['k-ref'];
    },
    deleteBlob: async (key) => {
      calls.push(`blob:${key}`);
    },
    deleteMeta: async (key) => {
      calls.push(`meta:${key}`);
    },
    ...over,
  };
  return { ports, calls };
}

describe('asset GC (P4b)', () => {
  it('候補 = meta ∪ blob の和集合。参照されない側だけが orphan(dangling 両型を含む)', async () => {
    const { ports, calls } = fakePorts();
    const found = await findOrphanAssets(ports);
    // 和集合 3 key が走査に渡る
    expect(calls[0]).toBe('scan:k-orphan-blob,k-orphan-meta,k-ref');
    expect([...found.keys].sort()).toEqual(['k-orphan-blob', 'k-orphan-meta']);
    // bytes だけの dangling は size 不明 = 0 扱い(過大報告しない)
    expect(found.knownBytes).toBe(20);
  });

  it('候補ゼロなら走査自体を呼ばない', async () => {
    const scan = vi.fn(async () => []);
    const { ports } = fakePorts({
      listMetas: async () => [],
      listBlobKeys: async () => [],
      scanReferenced: scan,
    });
    const found = await findOrphanAssets(ports);
    expect(found).toEqual({ keys: [], knownBytes: 0 });
    expect(scan).not.toHaveBeenCalled();
  });

  it('purge は key ごとに blob → meta の順。1 key の失敗は他を止めない', async () => {
    const { ports, calls } = fakePorts({
      deleteBlob: async (key) => {
        calls.push(`blob:${key}`);
        if (key === 'k-bad') throw new Error('idb fail');
      },
    });
    const r = await purgeAssets(ports, ['k-a', 'k-bad', 'k-b']);
    expect(r).toEqual({ deleted: 2, failed: 1 });
    // 失敗 key は meta を消さない(候補和集合に残り、次回 purge が回収する)
    expect(calls).toEqual([
      'blob:k-a',
      'meta:k-a',
      'blob:k-bad',
      'blob:k-b',
      'meta:k-b',
    ]);
  });

  it('cid に ":" は拒否(joiner 交差で他コンテナの bytes を消す経路を構造的に塞ぐ)', async () => {
    const store = new AssetBlobStore();
    // assert は IDB を触る**前**に走る(happy-dom に indexedDB が無くても検定可能)
    await expect(store.put('a:b', 'k1', new Blob(['x']))).rejects.toThrow(/cid/);
    await expect(store.listKeys('a:b')).rejects.toThrow(/cid/);
    await expect(store.delete('a:b', 'k1')).rejects.toThrow(/cid/);
  });

  /**
   * ⚠ **置き場が変わった**(#239、user 指示 2026-08-17「使う頻度が低いボタンは
   * 設定画面に逃す」)── 押す口(`data-pkc-action`)も受け手も同じで、居場所だけ
   * 左の列の下から設定の面へ移った。🔑 **委譲は `root` に張る**ので、面が変わっても
   * 同じ 1 本の配線で届く ── その「届く」ことこそがこの test の主張である。
   */
  it('設定の「使っていない添付を消す」click が services.purgeOrphanAssets に届く', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    root.append(buildSettingsCommands());
    const purge = vi.fn();
    bindActions(root, new Dispatcher(), { purgeOrphanAssets: purge });
    root
      .querySelector<HTMLElement>('[data-pkc-action="purge-orphan-assets"]')!
      .click();
    expect(purge).toHaveBeenCalledTimes(1);
  });
});

/** 明示フロー(review F1 の TOCTOU 保険)の pin。 */
describe('runExplicitPurge (P4b)', () => {
  function flowDeps(over: Partial<PurgeFlowDeps> = {}) {
    const { ports, calls } = fakePorts();
    const alerts: string[] = [];
    const deps: PurgeFlowDeps = {
      ports,
      isReady: async () => ({ ok: true, reason: '' }),
      confirm: () => true,
      alert: (m) => alerts.push(m),
      formatSize: (n) => `${n}B`,
      ...over,
    };
    return { deps, calls, alerts };
  }

  it('orphan ゼロなら confirm を出さずに報告だけ', async () => {
    const confirm = vi.fn(() => true);
    const { deps, calls, alerts } = flowDeps({ confirm });
    deps.ports.listMetas = async () => [];
    deps.ports.listBlobKeys = async () => [];
    await runExplicitPurge(deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(alerts[0]).toContain('未参照の添付データはありません');
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('confirm 拒否なら何も消さない(fail closed)', async () => {
    const { deps, calls } = flowDeps({ confirm: () => false });
    await runExplicitPurge(deps);
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('confirm 後に ready でなくなっていたら中止(編集開始の TOCTOU)', async () => {
    let ready = true;
    const { deps, calls, alerts } = flowDeps({
      isReady: async () =>
        ready ? { ok: true, reason: '' } : { ok: false, reason: '編集が始まったため中止しました' },
      confirm: () => {
        ready = false; // confirm ダイアログの間に編集が始まった
        return true;
      },
    });
    await runExplicitPurge(deps);
    expect(alerts[0]).toContain('中止しました');
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('confirm 後に再走査し、交差だけ消す(取込中 key / 参照され直した key を守る)', async () => {
    let scanCount = 0;
    const { ports, calls } = fakePorts({
      // 2 回目の走査では世界が変わっている:
      // - k-orphan-meta は参照され直した(referenced 入り)
      // - k-inflight が取込中(blob だけ書かれた)として新たに現れる
      listBlobKeys: async () =>
        scanCount >= 1 ? ['k-ref', 'k-orphan-blob', 'k-inflight'] : ['k-ref', 'k-orphan-blob'],
      scanReferenced: async () => {
        scanCount += 1;
        return scanCount === 1 ? ['k-ref'] : ['k-ref', 'k-orphan-meta'];
      },
    });
    const alerts: string[] = [];
    await runExplicitPurge({
      ports,
      isReady: async () => ({ ok: true, reason: '' }),
      confirm: () => true,
      alert: (m) => alerts.push(m),
      formatSize: (n) => `${n}B`,
    });
    // 消してよいのは「両方の走査で orphan」だった k-orphan-blob だけ
    expect(calls.filter((c) => c.startsWith('blob:'))).toEqual(['blob:k-orphan-blob']);
    expect(alerts[0]).toContain('1 件を削除しました');
  });
});

/**
 * 🔴 **他のタブが編集中なら整理しない**(#253)。
 *
 * ⚠ 未参照の走査は**保存済みの本文**しか見ないので、別のタブが編集中に貼った
 * 画像(bytes は在るが参照は未保存の欄の中)は「使っていない」に見える。
 * ⚠ 判定は 3 値 ── **「返事が無い」を「編集中」と同じ顔にしない**(そう言うと
 * user は存在しないタブを探しに行く)。
 */
describe('整理はタブ間の編集も見る(#253)', () => {
  it('🔴 3 値がそのまま文言に落ちる(顔を潰さない)', () => {
    expect(purgeBlockReason('idle'), '誰も編集していないのに断った').toBeNull();
    expect(purgeBlockReason('editing')).toContain('他のタブで編集中です');
    // 🔑 **「返事が無い」を「編集中」と同じ顔にしない** ── 言い切ると、
    //   user は開いていないタブを探しに行く(`EditGrant` の M-7 と同じ理由)
    expect(purgeBlockReason('unknown'), '確かめられないのに言い切った').not.toContain(
      '他のタブで編集中です',
    );
    expect(purgeBlockReason('unknown')).toContain('確かめられません');
    // ⚠ どちらも**次の一手**を含む(断りだけ出して終わらない)
    expect(purgeBlockReason('editing')).toContain('もう一度');
  });

  it('🔴 他のタブが編集中なら、confirm の後でも消さない', async () => {
    const { ports, calls } = fakePorts();
    const alerts: string[] = [];
    await runExplicitPurge({
      ports,
      isReady: async () => ({
        ok: false,
        reason: '他のタブで編集中です。そちらを保存してからもう一度お試しください',
      }),
      confirm: () => true,
      alert: (m) => alerts.push(m),
      formatSize: (n) => `${n}B`,
    });
    expect(calls.filter((c) => c.startsWith('blob:')), '編集中なのに消した').toHaveLength(0);
    expect(alerts[0]).toContain('他のタブで編集中です');
    // 🔑 **理由がそのまま出る**(「中止しました」だけだと次の一手が分からない)
    expect(alerts[0]).toContain('整理は行っていません');
  });

  it('⚠ 断りの文言は、判定の顔ごとに変える(存在しないタブを探させない)', async () => {
    const { ports } = fakePorts();
    const alerts: string[] = [];
    await runExplicitPurge({
      ports,
      isReady: async () => ({
        ok: false,
        reason: '本体タブと通信できないため、他のタブが編集中か確かめられません',
      }),
      confirm: () => true,
      alert: (m) => alerts.push(m),
      formatSize: (n) => `${n}B`,
    });
    expect(alerts[0], '「編集中」と言い切っている').not.toContain('他のタブで編集中です');
    expect(alerts[0]).toContain('確かめられません');
  });
});
