/** @vitest-environment happy-dom */
/**
 * 🔴 **添付を入れている間の進み具合**(#1652 4。Gemini 裁定 B ── 「1 枚目に 1 秒以上かかったときだけ出す」)。
 *
 * ⚠ 直す前は、添付ボタン・ドロップで入れている間、画面に何も出なかった(取り込むほうは「取り込み中…」が出る)。
 * 🔑 出す字は `…` で終わる(画面下の「進行中の欄」へ行く。結果の知らせと混ざらない)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import {
  attachFiles,
  SLOW_FIRST_MS,
  type AttachDeps,
} from '../../src/adapter/ui/actions/attach';
import { isProgressNotice } from '../../src/adapter/ui/render/status-notice';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

/** putBlob にかかる時間を呼び側が決める台。 */
function harness(putMs: (n: number) => number) {
  let puts = 0;
  const keys: string[] = [];
  const deps: AttachDeps = {
    gate: (run) => run(),
    putBlob: async (key) => {
      puts += 1;
      const ms = putMs(puts);
      if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
      keys.push(key);
    },
    putMeta: async () => {},
    listStoredBlobKeys: async () => [...keys],
  };
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  // 画面に出た知らせを順に控える(同じ字が続けて来ても 1 回の変化として数える)
  const notices: string[] = [];
  d.onState((s) => {
    if (s.notice !== null && notices[notices.length - 1] !== s.notice) notices.push(s.notice);
  });
  return { d, deps, notices };
}

const file = (name: string, byte: number): File =>
  new File([new Uint8Array([byte, byte + 1])], name, { type: 'application/octet-stream' });

// ⚠ 実時間で回す(偽の時計だと、ハッシュなど時計と無関係の非同期が進まず固まる)。1 秒の線を跨ぐので 1 本 1〜2 秒かかる。
const SLOW = SLOW_FIRST_MS + 300;

describe('添付の進み具合(#1652 4)', () => {
  it('🔴 1 枚目に 1 秒以上かかったら、「『x.mp4』を入れています…(2/3)」のように進み具合が出る', async () => {
    const h = harness((n) => (n === 1 ? SLOW : 10));
    await attachFiles(h.d, h.deps, [file('a.mp4', 1), file('b.mp4', 3), file('c.mp4', 5)]);
    const progress = h.notices.filter(isProgressNotice);
    expect(progress[0], '1 秒たっても 1 枚目の進み具合が出ない').toBe('『a.mp4』を入れています…(1/3)');
    expect(progress, '2 枚目以降の進み具合が出ない').toContain('『b.mp4』を入れています…(2/3)');
    expect(progress).toContain('『c.mp4』を入れています…(3/3)');
  });

  it('🔴 最後の 1 枚が済んだら、進行中の字は空に戻る(居座らない)', async () => {
    const h = harness((n) => (n === 1 ? SLOW : 10));
    await attachFiles(h.d, h.deps, [file('a.mp4', 1), file('b.mp4', 3)]);
    const idx = h.notices.map((t, i) => [t, i] as const).filter(([t]) => isProgressNotice(t));
    expect(idx.length, '前提:進み具合が出ていない').toBeGreaterThan(0);
    const after = h.notices.slice(idx[idx.length - 1]![1] + 1);
    expect(after, '終わりの合図(空の字)が来ていない').toContain('');
  });

  it('🔑 対照群 ── 1 枚目が速ければ(2 枚目が遅くても)出さない', async () => {
    const h = harness((n) => (n === 1 ? 10 : SLOW));
    await attachFiles(h.d, h.deps, [file('a.mp4', 1), file('b.mp4', 3)]);
    expect(h.notices.filter(isProgressNotice), '速かったのに進み具合を出した').toEqual([]);
  });

  it('🔑 1 枚だけの大きなファイルも、1 秒たてば出す(1/1)', async () => {
    const h = harness(() => SLOW);
    await attachFiles(h.d, h.deps, [file('big.mp4', 1)]);
    expect(h.notices.filter(isProgressNotice)).toEqual(['『big.mp4』を入れています…(1/1)']);
  });
});
