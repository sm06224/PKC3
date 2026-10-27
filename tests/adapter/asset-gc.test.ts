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
  isDurableVfs,
  refsInPendingTexts,
  runExplicitPurge,
  strayBlobKeys,
  withPendingRefs,
  type AssetGcPorts,
  type PurgeFlowDeps,
} from '../../src/adapter/platform/storage/asset-gc';
import type { MaintenanceJobPost } from '../../src/adapter/platform/storage/maintenance-task';
import {
  AssetBlobStore,
  splitStoreKey,
} from '../../src/adapter/platform/storage/asset-blob-store';
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
    // 既定では残骸なし(#260 の経路は専用の test で見る)
    listStrayBlobs: async () => [],
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
    deleteStrayBlob: async (storeKey) => {
      calls.push(`stray:${storeKey}`);
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
    expect(found).toEqual({ keys: [], strays: [], knownBytes: 0, details: [] });
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
  it('設定の「使われていない添付を消す」click が services.purgeOrphanAssets に届く', () => {
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
      ask: () => Promise.resolve(true),
      tell: async (m) => void alerts.push(m),
      post: () => undefined,
      ...over,
    };
    return { deps, calls, alerts };
  }

  it('orphan ゼロなら確認を出さずに報告だけ', async () => {
    const asked = vi.fn(async () => true);
    const { deps, calls, alerts } = flowDeps({ ask: asked });
    deps.ports.listMetas = async () => [];
    deps.ports.listBlobKeys = async () => [];
    await runExplicitPurge(deps);
    expect(asked).not.toHaveBeenCalled();
    expect(alerts[0]).toContain('どのノートからも使われていない添付はありません');
    // 🔑 理由も言う(#1640 ⑤-A)── 消したのに減らないとき、ここが唯一の手掛かりになる
    expect(alerts[0], '0 件の理由を言っていない').toContain('ゴミ箱・履歴に残っている添付は、使われているものとして数えます');
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('🔴 確認の文に、消した添付は元に戻せないと書く(#1087 A6)', async () => {
    const asked = vi.fn(async (...a: [string]) => a.length < 0);
    const { deps } = flowDeps({ ask: asked });
    await runExplicitPurge(deps);
    expect(asked, '前提: 確認が出ている(消す物が在る台)').toHaveBeenCalledTimes(1);
    const text = asked.mock.calls[0]![0];
    expect(text).toContain('消した添付は元に戻せません');
    // 問いは最後に ── 戻せないと読んでから「よろしいですか」を押せる
    expect(text.indexOf('元に戻せません')).toBeLessThan(text.indexOf('よろしいですか'));
  });

  it('🔴 確認に、消す添付を種類と大きさで最大 10 件並べ、残りは「ほか N 件」に畳む(#1640 ⑤-B)', async () => {
    const asked = vi.fn(async (...a: [string]) => a.length < 0);
    const many = Array.from({ length: 13 }, (_, i) => `k${i}`);
    const { deps } = flowDeps({ ask: asked });
    deps.ports.listMetas = async () =>
      many.map((key, i) => ({ key, size: 1024 * (i + 1), mime: i === 0 ? 'image/png' : null }));
    deps.ports.listBlobKeys = async () => [];
    deps.ports.scanReferenced = async () => [];
    await runExplicitPurge(deps);
    const text = asked.mock.calls[0]![0];
    const bullets = text.split('\n').filter((l) => l.startsWith('・'));
    expect(bullets, '10 件 + ほか').toHaveLength(11);
    expect(bullets[0]).toContain('image/png');
    expect(bullets[1], '種類が無いとき').toContain('種類不明');
    expect(bullets[10]).toBe('・ほか 3 件');
    // 問いと戻せない旨は、並べた後ろに残る
    expect(text.indexOf('・ほか')).toBeLessThan(text.indexOf('元に戻せません'));
  });

  it('confirm 拒否なら何も消さない(fail closed)', async () => {
    const { deps, calls } = flowDeps({ ask: () => Promise.resolve(false) });
    await runExplicitPurge(deps);
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('confirm 後に ready でなくなっていたら中止(編集開始の TOCTOU)', async () => {
    let ready = true;
    const { deps, calls, alerts } = flowDeps({
      isReady: async () =>
        ready ? { ok: true, reason: '' } : { ok: false, reason: '編集が始まったため中止しました' },
      ask: async () => {
        ready = false; // 確認のダイアログの間に編集が始まった
        return true;
      },
    });
    await runExplicitPurge(deps);
    expect(alerts[0]).toContain('中止しました');
    expect(calls.filter((c) => c.startsWith('blob:'))).toHaveLength(0);
  });

  it('confirm 後に再走査し、交差だけ消す(取り込み中 key / 参照され直した key を守る)', async () => {
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
      ask: () => Promise.resolve(true),
      tell: async (m) => void alerts.push(m),
      post: () => undefined,
    });
    // 消してよいのは「両方の走査で orphan」だった k-orphan-blob だけ
    expect(calls.filter((c) => c.startsWith('blob:'))).toEqual(['blob:k-orphan-blob']);
    expect(alerts[0]).toContain('1 件を消しました');
    // 🔴 容量の内訳の数が古くなったことも言う(#1087 の見直し 2026-10-13)
    expect(alerts[0]).toContain('もう一度「容量を調べる」を押すと新しくなります');
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
      ask: () => Promise.resolve(true),
      tell: async (m) => void alerts.push(m),
      post: () => undefined,
    });
    expect(calls.filter((c) => c.startsWith('blob:')), '編集中なのに消した').toHaveLength(0);
    expect(alerts[0]).toContain('他のタブで編集中です');
    // 🔑 **理由がそのまま出る**(「中止しました」だけだと次の一手が分からない)
    expect(alerts[0]).toContain('何も消していません');
  });

  it('⚠ 断りの文言は、判定の顔ごとに変える(存在しないタブを探させない)', async () => {
    const { ports } = fakePorts();
    const alerts: string[] = [];
    await runExplicitPurge({
      ports,
      isReady: async () => ({
        ok: false,
        reason: 'メインのタブと通信できないため、他のタブが編集中か確かめられません',
      }),
      ask: () => Promise.resolve(true),
      tell: async (m) => void alerts.push(m),
      post: () => undefined,
    });
    expect(alerts[0], '「編集中」と言い切っている').not.toContain('他のタブで編集中です');
    expect(alerts[0]).toContain('確かめられません');
  });
});

/**
 * 🔴 **どの器にも属さない bytes の回収**(#260、着地前レビュー ⚠-3)。
 *
 * cid が端末ごとの採番になった帰結。IDB の key は `${cid}:${assetKey}` で、
 * 掃除の候補集めは**自分の接頭辞しか見ない** ── OPFS を取れず `:memory:` に
 * 落ちた回の器は次の起動に残らないので、その回に貼った添付の bytes が
 * **誰の候補にも載らなくなる**(整理を何度押しても 0 件のまま容量だけ食う)。
 */
describe('器の無い bytes(#260)', () => {
  it('🔴 key は最初の `:` で割る(中身側に `:` が入っても壊れない)', () => {
    expect(splitStoreKey('c-abc:ast-1')).toEqual({ cid: 'c-abc', assetKey: 'ast-1' });
    expect(splitStoreKey('c-abc:ast:with:colons')).toEqual({
      cid: 'c-abc',
      assetKey: 'ast:with:colons',
    });
    // ⚠ 知らない形は触らない(消す側の誤爆を作らない)
    expect(splitStoreKey('no-prefix')).toBeNull();
    expect(splitStoreKey(':leading')).toBeNull();
  });

  it('🔴 生きていない器の key だけを拾う', () => {
    const all = [
      { storeKey: 'c-mine:a', cid: 'c-mine' },
      { storeKey: 'c-gone:b', cid: 'c-gone' },
      { storeKey: 'default:c', cid: 'default' },
    ];
    expect(strayBlobKeys(all, ['c-mine'], true)).toEqual(['c-gone:b', 'default:c']);
    expect(strayBlobKeys(all, ['c-mine', 'default'], true)).toEqual(['c-gone:b']);
  });

  /**
   * 🔴 **器の一覧が空なら 1 件も返さない。**
   * ⚠ 一覧を取り損ねた回に「全部が残骸」と読むと、**user の添付を全部消す**。
   *   誤差はこの向きにだけ倒す(CLAUDE.md §7)。
   */
  it('🔴 器の一覧が空なら、1 件も残骸と言わない', () => {
    const all = [{ storeKey: 'c-mine:a', cid: 'c-mine' }];
    expect(strayBlobKeys(all, [], true), '一覧を取り損ねた回に全部消しに行く').toEqual([]);
  });

  it('🔴 まだ保存していない字(追記欄・編集の控え)の中の参照を拾う', () => {
    const texts = ['追記の途中 ![](asset:k-paste)', '控えの本文 [資料](asset:k-draft)\n'];
    expect(refsInPendingTexts(texts, ['k-paste', 'k-draft', 'k-unused']).sort()).toEqual(['k-draft', 'k-paste']);
    // 対照群: 字が無ければ何も拾わない
    expect(refsInPendingTexts([], ['k-paste'])).toEqual([]);
  });

  /**
   * 🔴 **保存先がメモリへ落ちた回は、1 件も残骸と言わない**(#1087、添付の見直し)。
   * ⚠ その回の DB は空で、新しい器が 1 つだけ在る(一覧は空でない)。添付の bytes の置き場は別なので
   *   本来の器の bytes はそのまま残っている ── 「一覧に無い器 = 残骸」と読むと、本来の添付を全部消していた。
   */
  it('🔴 保存先がメモリへ落ちた回は、ほかの器の bytes を残骸と言わない', () => {
    const all = [
      { storeKey: 'c-real:a', cid: 'c-real' },
      { storeKey: 'c-real:b', cid: 'c-real' },
    ];
    // 対照群: 本物の保存先なら、一覧に無い器の bytes は残骸
    expect(strayBlobKeys(all, ['c-fresh'], true)).toEqual(['c-real:a', 'c-real:b']);
    expect(strayBlobKeys(all, ['c-fresh'], false), '本来の器の添付を消しに行く').toEqual([]);
  });

  it('🔴 保存先の判定:メモリは残骸の判定に使わない', () => {
    expect(isDurableVfs('memory')).toBe(false);
    expect(isDurableVfs('opfs-sahpool')).toBe(true);
  });

  it('🔴 走査の口に、まだ保存していない字の中の参照を合わせる(重ならない)', async () => {
    const scan = withPendingRefs(
      async () => ['k-body'],
      async () => ['![](asset:k-paste) ![](asset:k-body)'],
    );
    expect((await scan(['k-body', 'k-paste', 'k-unused'])).sort()).toEqual(['k-body', 'k-paste']);
  });

  it('🔴 まだ保存していない字を読めなければ、走査ごと失敗する(消す側へ倒さない)', async () => {
    const scan = withPendingRefs(
      async () => [],
      async () => {
        throw new Error('控えを読めない');
      },
    );
    await expect(scan(['k-paste'])).rejects.toThrow('控えを読めない');
  });

  /**
   * ⚠ **残骸を本文の走査に掛けない** ── 器が無い以上、参照しうる body が無い。
   * 掛けると、たまたま同じ asset key を使う**別の器の本文**に救われて永久に残る。
   */
  it('🔴 残骸は走査に掛けず、そのまま候補になる', async () => {
    const { ports, calls } = fakePorts({ listStrayBlobs: async () => ['c-gone:b'] });
    const scan = await findOrphanAssets(ports);
    expect(scan.strays).toEqual(['c-gone:b']);
    const scanCall = calls.find((c) => c.startsWith('scan:'));
    expect(scanCall, '走査そのものが走っていない(空振り)').toBeTruthy();
    expect(scanCall, '残骸まで本文の走査に掛けている').not.toContain('c-gone:b');
  });

  it('🔴 残骸は key をそのまま消す(meta は触らない)', async () => {
    const { ports, calls } = fakePorts();
    const r = await purgeAssets(ports, [], ['c-gone:b']);
    expect(r).toEqual({ deleted: 1, failed: 0 });
    expect(calls).toEqual(['stray:c-gone:b']);
  });

  /**
   * 🔴 **残骸しか無いときに「ありません」と言わない。**
   * ⚠ 直す前の形(`first.keys.length === 0` で早期 return)だと、残骸だけの端末は
   *   **押しても毎回「ありません」**と出て、容量は減らない。
   */
  it('🔴 残骸だけでも整理が走り、件数に数える', async () => {
    const { ports, calls } = fakePorts({
      listMetas: async () => [],
      listBlobKeys: async () => [],
      listStrayBlobs: async () => ['c-gone:b', 'c-gone:c'],
    });
    const messages: string[] = [];
    await runExplicitPurge({
      ports,
      isReady: async () => ({ ok: true, reason: '' }),
      ask: async (m) => {
        messages.push(m);
        return true;
      },
      tell: async (m) => void messages.push(m),
      post: () => undefined,
    });
    expect(messages[0], '残骸を数えていない').toContain('2 件');
    expect(messages.join(' '), '残骸だけだと「ありません」で止まる').not.toContain(
      'どのノートからも使われていない添付はありません',
    );
    expect(calls).toEqual(['stray:c-gone:b', 'stray:c-gone:c']);
  });
});

/**
 * 🔴 **`main.ts` の `purgeOrphanAssets` は、章の欄が開いている間も断る**
 *   (#1044 段2 5巡目の修理、U4)。
 *
 * ⚠ 直す前は `phase !== 'ready'` だけを見ていた ── 章の欄は `phase` を `ready` の
 *   まま保つので、章の欄が開いている間(下書きが disk と違う参照を持ちうる)に
 *   整理が走ると、その下書きの中にしか無い参照(bytes は在るが disk 未反映)を
 *   「使っていない」と誤認して消しうる。門は 2 か所(起点の可視ブロック +
 *   confirm 後の TOCTOU 再検査 `isReady`)ある ── 両方を見る。
 * ⚠ `main.ts` はどの test からも実行されない(CLAUDE.md §2)ので、原文 pin で
 *   妥協する ── `hasUnsavedTyping(` を通していることだけ見る。
 */
describe('main.ts の purgeOrphanAssets(原文 pin、#1044 段2 5巡目の修理、U4)', () => {
  it('🔴 起点の可視ブロックと isReady(TOCTOU)の両方が hasUnsavedTyping を通す', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/main.ts', 'utf-8');
    const at = src.indexOf('purgeOrphanAssets: () =>');
    expect(at, 'purgeOrphanAssets の service が読めない(空振り)').toBeGreaterThan(0);
    // ⚠ 次の同じインデントの service 定義(次のプロパティ)まで(末尾を名指しで区切る)
    const end = src.indexOf("\n  };\n  bindActions(", at);
    expect(end, '前提が崩れている(block の終端が見つからない)').toBeGreaterThan(at);
    const block = src.slice(at, end);
    // ⚠ 2 回とも出る(起点 + isReady の TOCTOU 再検査)ことを数える
    const hits = block.split('hasUnsavedTyping(').length - 1;
    expect(hits, 'hasUnsavedTyping を通していない箇所がある(章の欄の gap が戻っている)').toBe(2);
  });
});

/** #1385: 添付の整理も、他の片づけと同じ口(`reportMaintenance`)で処理の記録へ報告する。 */
describe('runExplicitPurge の処理の記録(#1385)', () => {
  function run(over: Partial<PurgeFlowDeps> = {}) {
    const { ports, calls } = fakePorts();
    const posts: MaintenanceJobPost[] = [];
    const deps: PurgeFlowDeps = {
      ports,
      isReady: async () => ({ ok: true, reason: '' }),
      ask: () => Promise.resolve(true),
      tell: async () => undefined,
      post: (m) => void posts.push(m),
      ...over,
    };
    return { deps, posts, calls };
  }

  it('消した回は出所 asset-gc で 1 件積む(固定の頭は付けない = done)', async () => {
    const { deps, posts, calls } = run();
    await runExplicitPurge(deps);
    expect(calls.filter((c) => c.startsWith('blob:')).length, '前提: 実際に消している').toBeGreaterThan(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: 'job', source: 'asset-gc' });
    expect(posts[0]?.text).toContain('件を消しました');
    expect(posts[0]?.fixedHead).toBeUndefined();
  });

  it('確認で止めた回・断られた回・0 件の回は積まない', async () => {
    const a = run({ ask: () => Promise.resolve(false) });
    await runExplicitPurge(a.deps);
    const b = run({ isReady: async () => ({ ok: false, reason: '他のタブで編集中です' }) });
    await runExplicitPurge(b.deps);
    const c = run();
    c.deps.ports.listMetas = async () => [];
    c.deps.ports.listBlobKeys = async () => [];
    await runExplicitPurge(c.deps);
    expect([a.posts, b.posts, c.posts]).toEqual([[], [], []]);
  });

  it('1 件も消せず失敗だけの回は failed として固定の頭つきで積む', async () => {
    const { deps, posts } = run();
    deps.ports.deleteBlob = async () => {
      throw new Error('boom');
    };
    await runExplicitPurge(deps);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.fixedHead).toBe(posts[0]?.text);
    expect(posts[0]?.text).toContain('失敗');
  });
});
