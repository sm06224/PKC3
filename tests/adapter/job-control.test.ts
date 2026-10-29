/** @vitest-environment happy-dom */
/**
 * 🔴 **「やめる」ボタンの出し入れ**(台帳 #1852 束 F2 / 依頼 253)。
 *
 * 観測点は ① 欄に実際に出る DOM(ボタンの有無・`data-pkc-action`)② 押した後に印が立つこと ③ 結果の欄を巻き込んで消さないこと。
 * 時間は fake の timer で進める(実時間を待たない)。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createJobControl, JOB_CANCELLING_TITLE, JOB_PANEL } from '../../src/adapter/ui/actions/job-control';
import { clearNotices, hideJobPanel, showJobPanel, showNotices } from '../../src/adapter/ui/render/notices';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; id: number; live: boolean }> = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, id: next++, live: true };
      pending.push(t);
      return t.id;
    },
    clearTimer: (id: unknown) => {
      for (const t of pending) if (t.id === id) t.live = false;
    },
    /** 待っている timer を全部鳴らす(時間が経った)。 */
    fire: () => {
      for (const t of pending) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
    delays: () => pending.map((t) => t.ms),
  };
}

let region: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="r" hidden></div>';
  region = document.getElementById('r')!;
});

function mount() {
  const timers = fakeTimers();
  const job = createJobControl(
    { show: (p) => showJobPanel(region, p), hide: () => hideJobPanel(region) },
    { setTimer: timers.setTimer, clearTimer: timers.clearTimer, delayMs: 800 },
  );
  return { job, timers };
}

const cancelButton = (): HTMLButtonElement | null =>
  region.querySelector<HTMLButtonElement>('[data-pkc-action="cancel-job"]');

describe('「やめる」ボタンは、少し待っても終わらない仕事にだけ出る', () => {
  it('始めた直後は出ない。待ち時間が過ぎると出る(取り込みの字)', () => {
    const { job, timers } = mount();
    job.start('import');
    expect(timers.delays(), '待ち時間が決まっていない').toEqual([800]);
    expect(cancelButton(), '始めた直後に出た(一瞬で終わる仕事で点滅する)').toBeNull();
    expect(region.hidden).toBe(true);
    timers.fire();
    expect(region.hidden).toBe(false);
    expect(cancelButton()?.textContent).toBe(JOB_PANEL.import.cancel);
    expect(region.textContent).toContain(JOB_PANEL.import.title);
  });

  it('書き出しは書き出しの字', () => {
    const { job, timers } = mount();
    job.start('export');
    timers.fire();
    expect(cancelButton()?.textContent).toBe('書き出しをやめる');
    expect(cancelButton()?.title).toContain('ファイルは作りません');
  });

  it('待ち時間より前に終わった仕事には、何も出ず何も残らない(finish が timer を止める)', () => {
    const { job, timers } = mount();
    const t = job.start('import');
    job.finish(t);
    timers.fire();
    expect(cancelButton()).toBeNull();
    expect(region.hidden).toBe(true);
  });

  it('出ていた欄は、仕事が終わると片づく', () => {
    const { job, timers } = mount();
    const t = job.start('import');
    timers.fire();
    expect(cancelButton()).not.toBeNull();
    job.finish(t);
    expect(cancelButton()).toBeNull();
    expect(region.hidden).toBe(true);
  });

  it('🔴 仕事の結果の欄(注意)がもう出ているなら、finish はそれを消さない', () => {
    const { job, timers } = mount();
    const t = job.start('import');
    timers.fire();
    showNotices(region, '取り込み時の注意', ['添付が欠けました']);
    job.finish(t);
    expect(region.hidden, '結果の欄を巻き込んで消した').toBe(false);
    expect(region.textContent).toContain('添付が欠けました');
    expect(region.hasAttribute('data-pkc-job-panel'), '結果の欄が「途中の欄」の印を持ったまま').toBe(false);
  });
});

describe('押したとき', () => {
  it('印が立ち、欄は「やめています…」になってボタンが消える(2 度押せない)', () => {
    const { job, timers } = mount();
    const t = job.start('import');
    timers.fire();
    expect(t.cancelled).toBe(false);
    expect(job.cancelCurrent()).toBe(true);
    expect(t.cancelled, '押したのに印が立たない').toBe(true);
    expect(region.textContent).toContain(JOB_CANCELLING_TITLE);
    expect(cancelButton(), 'やめている最中もボタンが残っている').toBeNull();
    expect(job.cancelCurrent(), '2 度目は何もしない').toBe(false);
  });

  it('仕事が無いときに押しても何も起きない(false)', () => {
    const { job } = mount();
    expect(job.cancelCurrent()).toBe(false);
  });

  it('待ち時間の前に押された(欄が出る前)でも印は立つ。欄は後から出ない', () => {
    const { job, timers } = mount();
    const t = job.start('export');
    expect(job.cancelCurrent()).toBe(true);
    expect(t.cancelled).toBe(true);
    timers.fire();
    expect(region.hidden, 'やめた後に欄が出た').toBe(true);
  });

  it('後から始まった仕事があれば、先の仕事の finish は後の欄を片づけない', () => {
    const { job, timers } = mount();
    const first = job.start('import');
    const second = job.start('export');
    timers.fire();
    job.finish(first);
    expect(cancelButton(), '先の仕事の終わりが後の仕事の欄を消した').not.toBeNull();
    job.finish(second);
    expect(cancelButton()).toBeNull();
  });
});

describe('binder: 欄のボタン(data-pkc-action="cancel-job")', () => {
  it('押すと cancelJob が呼ばれる。対照群: 別のボタンでは呼ばれない', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const calls: string[] = [];
    bindActions(root, new Dispatcher(), { cancelJob: () => void calls.push('cancel') });
    const { job, timers } = mount();
    root.append(region);
    const t = job.start('import');
    timers.fire();
    const other = document.createElement('button');
    other.setAttribute('data-pkc-action', 'dismiss-notices');
    root.append(other);
    other.click();
    expect(calls, '別のボタンで呼ばれた').toEqual([]);
    cancelButton()!.click();
    expect(calls).toEqual(['cancel']);
    job.finish(t);
    clearNotices(region);
  });
});

describe('main.ts の配線(原文 pin)', () => {
  const MAIN = readFileSync('src/main.ts', 'utf8');
  it('空振り防止 ── main.ts を本当に読めている', () => {
    expect(MAIN.length).toBeGreaterThan(10000);
  });
  it('🔴 欄の出し入れ・取り込み・書き出し・ボタンの受け口が 1 本の jobs に繋がっている', () => {
    expect(MAIN).toContain('createJobControl({');
    expect(MAIN).toContain('showJobPanel(regions.notices, panel)');
    expect(MAIN).toContain('hideJobPanel(regions.notices)');
    // 取り込み(importDeps)と書き出し(runExport の deps)と PKC3 入り HTML の書き出し(runExportPortable)が同じ jobs を受ける
    expect(MAIN.match(/\bjob: jobs,/g)?.length, 'job: jobs が取り込み・書き出し・PKC3 入り HTML の書き出しの 3 か所に無い').toBe(3);
    // やめたときの取り消しは「取り込みを取り消す」と同じ importUndo.undo()
    expect(MAIN).toMatch(/undoImport: \(\) => importUndo\.undo\(\),\s+\/\/ ⚠ 生存 entry だけでは/);
    expect(MAIN).toContain('cancelJob: () => void jobs.cancelCurrent()');
  });
});
