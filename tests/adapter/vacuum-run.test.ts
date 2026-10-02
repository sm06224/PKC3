/** @vitest-environment happy-dom */
/**
 * 🔴 **保存領域を縮める係(`StorageVacuum`)と、設定の「縮める」**(#999。Gemini 裁定 A)。
 *
 * 守っているもの:
 * - 表示: 測る前 / 見込み / 空き不足 / 縮める分なし / 別のタブが担当 / 動作中 / 測れなかった
 * - 🔴 **順番**: 縮める本体は**書込の列の中**で、**打つ直前に測り直した値**で判断する
 *   (押してから列に載るまでに状況が変わっても、空き不足なら打たない)
 * - 🔴 結果は処理の記録へ 1 件(「→」と秒)/ 失敗も 1 件(例外の字をそのまま出さない)
 * - 🔴 2 度押しは断る / 失敗しても次を押せる / 別のタブからは打たない
 * - 画面: 設定の「保存領域の大きさ」に見込みが出て、押せないときは `disabled` で理由が見える。
 *   押すと binder → 係 → 結果の知らせまで繋がる(押して無言にならない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import {
  appStorageVacuum,
  StorageVacuum,
  VACUUM_REFRESH_MIN_MS,
  type VacuumDeps,
} from '../../src/adapter/platform/storage/vacuum-run';
import type { VacuumResult } from '../../src/adapter/platform/storage/protocol';
import { VACUUM_NO_ROOM_TEXT, VACUUM_NOTHING_TEXT } from '../../src/features/storage/vacuum';

const MiB = 1024 * 1024;
const gaugeOf = (fileMiB: number, freeMiB: number): VacuumResult['before'] => ({
  pageCount: (fileMiB * MiB) / 4096,
  pageSize: 4096,
  freelistCount: (freeMiB * MiB) / 4096,
  fileBytes: fileMiB * MiB,
  freeBytes: freeMiB * MiB,
  ftsSegments: 1,
  journalMode: 'truncate',
  tempStore: 0,
  synchronous: 2,
  elapsedMs: 1,
});
const ROOMY = { usage: 10 * MiB, quota: 10_000 * MiB };

/** 値を差し替えられる配線一式。`log` に呼ばれた順番が残る。 */
function rig(over: Partial<VacuumDeps> = {}) {
  const log: string[] = [];
  const posted: { kind: string; source: string; text: string }[] = [];
  const st = {
    gauge: gaugeOf(100, 20),
    quota: ROOMY as { usage?: number; quota?: number },
    holder: true,
    result: { elapsedMs: 2100, before: gaugeOf(100, 20), after: gaugeOf(80, 0) } as VacuumResult,
    vacuumError: null as Error | null,
    inRun: false,
    now: 1_000,
  };
  const deps: VacuumDeps = {
    holdsWriterLease: () => st.holder,
    run: async (job) => {
      log.push('run:start');
      st.inRun = true;
      try {
        return await job();
      } finally {
        st.inRun = false;
        log.push('run:end');
      }
    },
    gauge: async () => {
      log.push(`gauge${st.inRun ? '(列の中)' : ''}`);
      return st.gauge;
    },
    quota: async () => st.quota,
    vacuum: async () => {
      log.push(`vacuum${st.inRun ? '(列の中)' : ''}`);
      if (st.vacuumError) throw st.vacuumError;
      return st.result;
    },
    post: (m) => void posted.push(m),
    now: () => st.now,
    ...over,
  };
  const v = new StorageVacuum();
  return { v, deps, log, posted, st };
}

/** microtask をまとめて流す(測り終わりを待つ)。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('表示(view)', () => {
  it('🔴 配線が無い環境: 押せない・理由を言う', () => {
    expect(new StorageVacuum().view()).toEqual({
      text: 'この環境では縮められません',
      canRun: false,
      busy: false,
    });
  });

  it('🔴 測り終わる前は押せない(「測れなかった」とは言わない)→ 測り終わると見込みが出て押せる', async () => {
    const { v, deps } = rig();
    v.attach(deps);
    expect(v.view().canRun, '測る前から押せる').toBe(false);
    expect(v.view().text).toContain('調べています');
    v.refresh();
    await settle();
    expect(v.view()).toEqual({
      text: 'いま 100.0 MB、縮めると約 80.0 MB になる見込み。1〜5 秒ほど保存できません。',
      canRun: true,
      busy: false,
    });
  });

  it('🔴 空き不足 → 押せない + 理由 / 縮む分なし → 押せない + 理由', async () => {
    const a = rig();
    a.st.quota = { usage: 950 * MiB, quota: 1000 * MiB };
    a.v.attach(a.deps);
    a.v.refresh();
    await settle();
    expect(a.v.view()).toEqual({ text: VACUUM_NO_ROOM_TEXT, canRun: false, busy: false });

    const b = rig();
    b.st.gauge = gaugeOf(100, 0);
    b.v.attach(b.deps);
    b.v.refresh();
    await settle();
    expect(b.v.view()).toEqual({ text: VACUUM_NOTHING_TEXT, canRun: false, busy: false });
  });

  it('🔴 別のタブが保存を担当しているとき: 押せない + 理由(担当のタブで押す)', async () => {
    const { v, deps, st } = rig();
    st.holder = false;
    v.attach(deps);
    v.refresh();
    await settle();
    expect(v.view().canRun).toBe(false);
    expect(v.view().text).toContain('保存を担当しているタブ');
  });

  it('🔴 測れなかった → 押せない側(古い値を残さない)', async () => {
    const { v, deps, st } = rig();
    v.attach(deps);
    v.refresh();
    await settle();
    expect(v.view().canRun).toBe(true);
    st.now += VACUUM_REFRESH_MIN_MS;
    deps.gauge = async () => {
      throw new Error('x');
    };
    v.refresh();
    await settle();
    expect(v.view()).toEqual({ text: '保存領域の大きさを測れませんでした', canRun: false, busy: false });
  });

  it('🔴 測り直しは間隔を置く(設定を開いている間、状態が動くたびに測らない)', async () => {
    const { v, deps, st, log } = rig();
    v.attach(deps);
    v.refresh();
    await settle();
    const n = log.filter((l) => l.startsWith('gauge')).length;
    expect(n, '前提: 1 回は測っている').toBe(1);
    st.now += VACUUM_REFRESH_MIN_MS - 1;
    v.refresh();
    await settle();
    expect(log.filter((l) => l.startsWith('gauge')).length, '間隔の内なのに測り直した').toBe(1);
    st.now += 1;
    v.refresh();
    await settle();
    expect(log.filter((l) => l.startsWith('gauge')).length, '間隔を過ぎたのに測り直さない').toBe(2);
  });
});

describe('縮める(run)', () => {
  it('🔴 本体は書込の列の中・打つ直前に測り直す・結果を処理の記録へ 1 件', async () => {
    const { v, deps, log, posted } = rig();
    v.attach(deps);
    const r = await v.run();
    expect(r).toEqual({ kind: 'done', text: '保存領域を縮めました(100.0 MB → 80.0 MB、2.1 秒)' });
    // 🔑 列の中で測り直してから打つ(列の外で測った値で打たない)
    expect(log.slice(0, 4)).toEqual(['run:start', 'gauge(列の中)', 'vacuum(列の中)', 'run:end']);
    expect(posted).toEqual([
      { kind: 'job', source: 'storage-vacuum', text: '保存領域を縮めました(100.0 MB → 80.0 MB、2.1 秒)' },
    ]);
  });

  it('🔴 押してから列に載るまでに空きが足りなくなったら、打たない(打つ直前の値で判断)', async () => {
    const { v, deps, log, posted, st } = rig();
    v.attach(deps);
    v.refresh();
    await settle();
    expect(v.view().canRun, '前提: 押す前は押せる').toBe(true);
    // 押した後、列の中で測ると空きが足りない
    st.quota = { usage: 950 * MiB, quota: 1000 * MiB };
    const r = await v.run();
    expect(r).toEqual({ kind: 'refused', text: VACUUM_NO_ROOM_TEXT });
    expect(log.some((l) => l.startsWith('vacuum')), '空き不足なのに VACUUM を打った').toBe(false);
    expect(posted, '打っていないのに処理の記録へ積んだ').toEqual([]);
  });

  it('🔴 縮む分が無くなっていたら、打たない', async () => {
    const { v, deps, log, st } = rig();
    v.attach(deps);
    st.gauge = gaugeOf(100, 0);
    const r = await v.run();
    expect(r).toEqual({ kind: 'refused', text: VACUUM_NOTHING_TEXT });
    expect(log.some((l) => l.startsWith('vacuum'))).toBe(false);
  });

  it('🔴 別のタブが担当のとき打たない(中継の待ち 10 秒を超えて失敗に見えるため)', async () => {
    const { v, deps, log, st } = rig();
    st.holder = false;
    v.attach(deps);
    const r = await v.run();
    expect(r.kind).toBe('refused');
    expect(log, '担当でないのに列へ載せた').toEqual([]);
  });

  it('🔴 失敗: 理由を言い換えて処理の記録へ 1 件 / 例外の字を出さない / 次を押せる', async () => {
    const { v, deps, posted, st } = rig();
    v.attach(deps);
    st.vacuumError = new Error('SQLITE_ERROR: 本文の一部 秘密');
    const r = await v.run();
    expect(r).toEqual({ kind: 'failed', text: '縮められませんでした(保存領域に書けませんでした)' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).not.toContain('秘密');
    expect(v.view().busy, '失敗したのに動作中のまま').toBe(false);
    // 失敗の後でも、もう 1 度押せる
    st.vacuumError = null;
    expect((await v.run()).kind).toBe('done');
  });

  it('🔴 動いている間の 2 度押しは断る(理由を言う)/ 動いている間は押せない表示', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { v, deps, log } = rig();
    deps.vacuum = async () => {
      log.push('vacuum');
      await gate;
      return { elapsedMs: 10, before: gaugeOf(100, 20), after: gaugeOf(80, 0) };
    };
    v.attach(deps);
    const first = v.run();
    await settle();
    expect(v.view().busy).toBe(true);
    expect(v.view().canRun).toBe(false);
    const second = await v.run();
    expect(second.kind).toBe('refused');
    expect(second.text).toContain('いま縮めています');
    release();
    expect((await first).kind).toBe('done');
    expect(log.filter((l) => l === 'vacuum'), '2 度打った').toHaveLength(1);
  });

  it('🔴 縮めた直後は測り直して、「縮める分がありません」を映す', async () => {
    const { v, deps, st } = rig();
    // 縮める前は 20 MiB 空き、縮めた後は 0(実物と同じ向き)
    let vacuumed = false;
    deps.gauge = async () => (vacuumed ? gaugeOf(80, 0) : st.gauge);
    deps.vacuum = async () => {
      vacuumed = true;
      return st.result;
    };
    v.attach(deps);
    v.refresh();
    await settle();
    expect(v.view().canRun, '前提: 縮める前は押せる').toBe(true);
    await v.run();
    await settle();
    // 🔑 縮める前の値(20 MiB 空き)が出たままでない ── 測り直している
    expect(v.view()).toEqual({ text: VACUUM_NOTHING_TEXT, canRun: false, busy: false });
  });
});

describe('画面(設定の「保存領域の大きさ」)', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  function pane(v: StorageVacuum): { root: HTMLElement; status: string[]; fail: string[] } {
    const root = document.createElement('div');
    document.body.append(root);
    const status: string[] = [];
    const fail: string[] = [];
    const dispatcher = {
      getState: () => initialState,
      dispatch: vi.fn((a: { type: string; error?: string }) => {
        if (a.type === 'OP_FAILED') fail.push(a.error ?? '');
      }),
    };
    bindActions(root, dispatcher as never, { showStatus: (t) => void status.push(t) });
    // ⚠ 係は**末尾の引数**(その手前 18 個は既定のまま)── 位置引数で渡す
    const make = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
    const settings = new make(root, new JobMonitor(), ...Array<undefined>(18).fill(undefined), v);
    settings.render(initialState);
    return { root, status, fail };
  }

  const note = (root: HTMLElement): HTMLElement | null =>
    root.querySelector('[data-pkc-region="storage-vacuum"] [data-pkc-field="vacuum-note"]');
  const btn = (root: HTMLElement): HTMLButtonElement | null =>
    root.querySelector('[data-pkc-region="storage-vacuum"] [data-pkc-action="storage-vacuum"]');

  it('🔴 「保存領域」の節に見出し・字・ボタンが在り、測り終わると見込みが出て押せる', async () => {
    const { v, deps } = rig();
    v.attach(deps);
    const { root } = pane(v);
    expect(root.querySelector('[data-pkc-region="settings-storage"] [data-pkc-region="storage-vacuum"]')).not.toBeNull();
    expect(root.querySelector('[data-pkc-region="storage-vacuum"] h4')?.textContent).toBe('保存領域の大きさ');
    expect(btn(root)?.textContent).toContain('縮める');
    // 測り終わるまでは押せない
    expect(btn(root)?.disabled).toBe(true);
    await settle();
    expect(note(root)?.textContent).toBe(
      'いま 100.0 MB、縮めると約 80.0 MB になる見込み。1〜5 秒ほど保存できません。',
    );
    expect(btn(root)?.disabled, '押せるのに disabled のまま').toBe(false);
  });

  it('🔴 空きが足りないとき: ボタンは押せず、理由が画面の字として見える', async () => {
    const { v, deps, st } = rig();
    st.quota = { usage: 950 * MiB, quota: 1000 * MiB };
    v.attach(deps);
    const { root } = pane(v);
    await settle();
    expect(btn(root)?.disabled).toBe(true);
    expect(note(root)?.textContent).toBe(VACUUM_NO_ROOM_TEXT);
    expect(note(root)?.hidden, '理由が隠れている').toBe(false);
  });

  it('🔴 押すと 係 → 結果の知らせまで繋がる / 失敗はエラーの行へ', async () => {
    const { deps, st, posted } = rig();
    // binder が呼ぶのはアプリで 1 つの係 ── 同じ配線を渡す
    appStorageVacuum.attach(deps);
    const { root, status, fail } = pane(appStorageVacuum);
    await settle();
    btn(root)!.click();
    await settle();
    await settle();
    expect(status).toEqual(['保存領域を縮めました(100.0 MB → 80.0 MB、2.1 秒)']);
    expect(posted).toHaveLength(1);
    // 失敗はエラーの行(成功の知らせと混ぜない)
    st.gauge = gaugeOf(100, 20);
    st.vacuumError = new Error('x');
    appStorageVacuum.refresh(true);
    await settle();
    btn(root)!.click();
    await settle();
    await settle();
    expect(fail).toEqual(['縮められませんでした(保存領域に書けませんでした)']);
    expect(posted, '失敗も処理の記録へ 1 件').toHaveLength(2);
  });
});

/**
 * 🔴 **main.ts の配線**(原文 pin)── この file はどの test からも実行されない(CLAUDE.md §2)。
 * ⚠ 見るのは**実行する行**(注釈を剥いでから)── 注釈には同じ字が在る。
 */
describe('main.ts の配線(原文 pin)', () => {
  const code = codeOnly(readFileSync('src/main.ts', 'utf-8'));

  it('🔴 lease の判定は writerHolder・列は storeEffects.run・打つ op は vacuum・測る op は storageGauge', () => {
    const m = /appStorageVacuum\.attach\(\{([\s\S]*?)\}\);/.exec(code);
    expect(m, '縮める係を組む所が見つからない(空振り防止)').not.toBeNull();
    const body = m?.[1] ?? '';
    expect(body).toContain('holdsWriterLease: () => writerHolder');
    expect(body).toContain('storeEffects.run(job)');
    expect(body).toContain("op: 'vacuum'");
    expect(body).toContain("op: 'storageGauge'");
    expect(body).toContain('navigator.storage.estimate()');
  });

  it('🔴 可搬の単一 HTML(portable)では組まない(自動の係と同じ囲みの中)', () => {
    const at = code.indexOf('appStorageVacuum.attach(');
    const from = code.lastIndexOf('if (portable === null) {', at);
    expect(from, '囲み(portable === null)が見つからない').toBeGreaterThan(-1);
    // 囲みの中に自動の係の組み立てが在る(= 同じ囲み)
    expect(code.slice(from, at)).toContain('new AutoOptimizer(');
  });
});
