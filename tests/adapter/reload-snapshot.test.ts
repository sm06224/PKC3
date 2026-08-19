/** @vitest-environment happy-dom */
/**
 * P8 段㉕: 🔴 **案内したことを実行する**。
 *
 * 🔴 取込が編集中に終わると「取込は完了しました。編集を終了すると一覧に
 * 反映されます」と出るのに、**予約する仕組みが無かった** ── 編集を終えても
 * 一覧に 1 件も出ない。
 *
 * 壊れ方: OS のファイル関連付けで `.md` を数十件ダブルクリック → 取込が始まる →
 * 数秒かかる間に user がノートを開いて編集を始める → 完了時に上の 1 行が出るだけで
 * 一覧は変わらない → user は「取り込めなかった」と判断して**同じファイルを
 * もう一度取り込む** → lid は振り直されるので**二重取込が実データとして残る**。
 *
 * 🔑 この file が在るのは「**測れるようにするため**」── `main.ts` の closure に
 * 居たときは誰も test できなかった(段㉔ の `window-close.ts` と同じ理由)。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  reloadSnapshot,
  DEFERRED_RELOAD_NOTICE,
} from '../../src/adapter/state/reload-snapshot';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: `t-${lid}`,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** ready 状態の dispatcher を作る。 */
function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return d;
}

describe('取込後の一覧の入れ替え', () => {
  it('⚠ ready ならその場で入れ替える(空振り防止 ── 常に延期する実装でも下は通る)', async () => {
    const d = booted();
    await reloadSnapshot(d, 'c1', async () => ({ metas: [meta('a')], relations: [] }));
    expect([...d.getState().entryMetas.keys()]).toEqual(['a']);
  });

  it('🔴 編集中は入れ替えず、案内を出す(打ちかけの本文を消さない)', async () => {
    const d = booted();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 失いたくない下書き\n' });
    expect(d.getState().phase, '編集に入れていない').toBe('editing');

    await reloadSnapshot(d, 'c1', async () => ({ metas: [meta('a')], relations: [] }));
    expect(d.getState().openBody?.body, '下書きが消えた').toBe('# 失いたくない下書き\n');
    expect(d.getState().error).toBe(DEFERRED_RELOAD_NOTICE);
    expect([...d.getState().entryMetas.keys()], '編集中なのに入れ替えた').not.toContain('a');
  });

  /**
   * 🔴 **本丸** ── 編集を終えたら、案内どおりに一覧へ出る。
   * ⚠ 観測点は「案内が出たか」ではなく「**そのあと実際に反映されたか**」。
   */
  it('🔴 編集を終えると、予約していた入れ替えが実行される', async () => {
    const d = booted();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'x\n' });

    await reloadSnapshot(d, 'c1', async () => ({ metas: [meta('a')], relations: [] }));
    expect([...d.getState().entryMetas.keys()]).not.toContain('a');

    // 編集を抜ける(ready へ戻る)
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(d.getState().phase).toBe('ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(
      [...d.getState().entryMetas.keys()],
      '編集を終えても一覧に出ない(案内が嘘になっている)',
    ).toContain('a');
  });

  /**
   * 🔴 **待ってから取り直す**。待つ前に取った snapshot を使うと、待っている間に
   * 保存された編集が載っておらず**古い一覧で上書き**してしまう。
   */
  it('🔴 一覧は「編集を終えたとき」に取り直す(先に取ったものを使わない)', async () => {
    const d = booted();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'x\n' });

    const load = vi.fn(async () => ({ metas: [meta('a')], relations: [] }));
    await reloadSnapshot(d, 'c1', load);
    expect(load, '待つ前に一覧を取っている').not.toHaveBeenCalled();

    d.dispatch({ type: 'CANCEL_EDIT' });
    await new Promise((r) => setTimeout(r, 0));
    expect(load, '待ったあとに取っていない').toHaveBeenCalledTimes(1);
  });
});

/** #177: タブ間同期の取り直しは、編集中でも**黙って**先送りできる。 */
describe('deferNotice(先送りの案内の差し替え)', () => {
  function editing(): Dispatcher {
    const d = booted();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    return d;
  }

  it('省略時は従来の取込文言(後方互換)', async () => {
    const d = editing();
    await reloadSnapshot(d, 'c1', async () => ({ metas: [], relations: [] }));
    expect(d.getState().error).toBe(DEFERRED_RELOAD_NOTICE);
  });

  it('null なら案内を出さずに先送りだけする(別タブの保存のたびに帯を出さない)', async () => {
    const d = editing();
    await reloadSnapshot(d, 'c1', async () => ({ metas: [meta('a')], relations: [] }), {
      deferNotice: null,
    });
    expect(d.getState().error, '黙る約束なのに帯が出ている').toBeNull();
    // 先送り自体は生きている ── 編集を終えると入れ替わる
    d.dispatch({ type: 'CANCEL_EDIT' });
    await new Promise((r) => setTimeout(r, 0));
    expect([...d.getState().entryMetas.keys()]).toContain('a');
  });

  it('文言を差し替えられる(押した場所と対の文言 ── §1)', async () => {
    const d = editing();
    await reloadSnapshot(d, 'c1', async () => ({ metas: [], relations: [] }), {
      deferNotice: '同期しました。編集を終了すると反映されます',
    });
    expect(d.getState().error).toBe('同期しました。編集を終了すると反映されます');
  });
});

/** レビュー H-3: ready 検査と dispatch の間(読込の await)に編集が始まる窓。 */
describe('読込中に編集が始まった場合(H-3)', () => {
  it('🔴 取ったあとに phase を見直す ── 編集中に SYS_BOOTED を落として下書きを消さない', async () => {
    const d = booted();
    let resolveLoad!: (s: { metas: EntryMeta[]; relations: [] }) => void;
    const load = vi.fn(
      () => new Promise<{ metas: EntryMeta[]; relations: [] }>((r) => (resolveLoad = r)),
    );
    const p = reloadSnapshot(d, 'c1', load, { deferNotice: null });
    expect(load).toHaveBeenCalledTimes(1); // ready だったので即読みに入った
    // 読んでいる間に user が編集を始める
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打ちかけ\n' });
    expect(d.getState().phase).toBe('editing');
    resolveLoad({ metas: [meta('a')], relations: [] });
    await p;
    await new Promise((r) => setTimeout(r, 0));
    // 🔴 編集は生きている(SYS_BOOTED が openBody を捨てていない)
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().openBody?.body).toBe('打ちかけ\n');
    // 編集を終えると、**取り直した** snapshot で入れ替わる(古いのを使わない)
    d.dispatch({ type: 'CANCEL_EDIT' });
    await new Promise((r) => setTimeout(r, 0)); // 予約 → boot → 2 回目の load() まで進める
    expect(load).toHaveBeenCalledTimes(2);
    resolveLoad({ metas: [meta('b')], relations: [] }); // 2 回目の load を解決
    await new Promise((r) => setTimeout(r, 0));
    expect([...d.getState().entryMetas.keys()]).toContain('b');
  });

  it('先送りの予約は 1 個に束ねる(別タブの保存が N 回来ても boot は 1 回)', async () => {
    const d = booted();
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'draft', title: 'd' });
    const load = vi.fn(async () => ({ metas: [meta('a')], relations: [] }));
    await reloadSnapshot(d, 'c1', load, { deferNotice: null });
    await reloadSnapshot(d, 'c1', load, { deferNotice: null });
    await reloadSnapshot(d, 'c1', load, { deferNotice: null });
    d.dispatch({ type: 'CANCEL_EDIT' });
    await new Promise((r) => setTimeout(r, 0));
    expect(load, '予約が積み上がって連射された').toHaveBeenCalledTimes(1);
  });

  it('読込の失敗は帯に出る(黙って落とさない ── L-2)', async () => {
    const d = booted();
    await reloadSnapshot(d, 'c1', async () => {
      throw new Error('本体タブと通信できません(応答がありません)');
    });
    expect(d.getState().error).toContain('一覧を取り直せませんでした');
  });
});
