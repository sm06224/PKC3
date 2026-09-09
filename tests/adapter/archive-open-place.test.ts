/** @vitest-environment happy-dom */
/**
 * 🔴 **「中を見る」を押したとき、どこに出るか**(#826。user 指摘 2026-09-09
 * 「**普通に別窓で開くとここで開くは共存で、デフォをどちらとするかは
 * ユーザー設定では？**」)。
 *
 * ⚠ **ここでしか見えないのは「選び分け」である** ── 別の窓の中身は
 * `archive-window.test.ts` が、実物の窓は smoke が見る。ここが守るのは:
 * 1. 既定(別の窓)では、**その場の器を使わない**
 * 2. 🔴 **塞がれたら、その場の器へ落ちて理由を言う**(いちばん再現しない道)
 * 3. 「この画面」を選んだ人には、**窓を掴もうとしない**
 *    (掴めなかったのか、選んだ結果なのかを混ぜない)
 * 4. 🔴 読めなかった回は、**掴んだ窓を必ず閉じる**(「読んでいます…」を残さない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildZip, bytesOf } from '../features/zip-fixture';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { OPEN_PLACE_KEY } from '../../src/adapter/ui/render/open-place';

/** 中身のある zip(実物の目録を読ませる ── 作り物の rows を渡さない)。 */
async function zipBlob(): Promise<Blob> {
  const bytes = await buildZip([
    { name: '写真/海.jpg', bytes: bytesOf('umi') },
    { name: 'readme.txt', bytes: bytesOf('hello') },
  ]);
  return new Blob([bytes as unknown as BlobPart]);
}

interface Harness {
  root: HTMLElement;
  status: string[];
  grabbed: string[];
  picked: number;
  closed: number;
}

function setup(over: Partial<BinderServices> & { grab?: 'ok' | 'blocked' }): Harness {
  const root = document.createElement('div');
  root.innerHTML =
    '<button data-pkc-action="browse-archive" data-pkc-asset-key="k1" ' +
    'data-pkc-asset-name="書庫.zip">中を見る</button>';
  document.body.append(root);
  const h: Harness = { root, status: [], grabbed: [], picked: 0, closed: 0 };
  const services: BinderServices = {
    showStatus: (t) => h.status.push(t),
    readAssetBlob: async () => zipBlob(),
    attachFiles: () => undefined,
    ...(over.grab === undefined
      ? {}
      : {
          grabArchiveWindow: (_title, key) => {
            h.grabbed.push(key);
            if (over.grab === 'blocked') return null;
            return {
              pick: async () => {
                h.picked += 1;
                return null; // 「やめる」相当 ── ここでは選び分けだけを見る
              },
              close: () => {
                h.closed += 1;
              },
            };
          },
        }),
    ...over,
  };
  bindActions(root, new Dispatcher(), services);
  return h;
}

/** 押して、非同期の連鎖が落ち着くまで待つ。 */
async function press(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-pkc-action="browse-archive"]')!.click();
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

const dialogOpen = (): boolean =>
  document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]')?.open === true;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  resetAppDialogForTest();
  document.body.textContent = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('書庫をどこで開くか', () => {
  it('🔴 既定は別の窓 ── その場の器は開かない', async () => {
    const h = setup({ grab: 'ok' });
    await press(h.root);
    expect(h.grabbed, '窓を掴んでいない').toEqual(['k1']);
    expect(h.picked, '別の窓に一覧を組んでいない').toBe(1);
    expect(dialogOpen(), '別の窓で開いたのに、その場の器も開いた').toBe(false);
  });

  it('🔴 塞がれたら、その場の器へ落ちて理由を言う', async () => {
    const h = setup({ grab: 'blocked' });
    await press(h.root);
    expect(h.grabbed).toEqual(['k1']);
    expect(dialogOpen(), '塞がれたのに、その場の器も出ない = 押して無反応').toBe(true);
    expect(
      h.status.join(' / '),
      '落ちた理由を言っていない(user は「壊れた」と読む)',
    ).toContain('別の窓が開けなかった');
  });

  it('「この画面」を選んだ人には、窓を掴もうとしない', async () => {
    localStorage.setItem(OPEN_PLACE_KEY, 'here');
    const h = setup({ grab: 'ok' });
    await press(h.root);
    expect(h.grabbed, '選んだ結果なのに窓を掴んだ').toEqual([]);
    expect(dialogOpen()).toBe(true);
    // ⚠ 選んだ人に「開けませんでした」と言わない(混ぜない)
    expect(h.status.join(' / ')).not.toContain('別の窓が開けなかった');
  });

  /** ⚠ 渡らない版(古い外殻)では、今までどおりその場の器で開く。 */
  it('窓を掴む口が無い版では、その場の器で開く', async () => {
    const h = setup({});
    await press(h.root);
    expect(dialogOpen()).toBe(true);
  });

  it('🔴 中身が読めなかったら、掴んだ窓を閉じる(「読んでいます…」を残さない)', async () => {
    const h = setup({ grab: 'ok', readAssetBlob: async () => null });
    await press(h.root);
    expect(h.closed, '読めなかったのに窓が残っている').toBe(1);
    expect(h.picked, '読めていないのに一覧を組んだ').toBe(0);
    expect(h.status.join(' / ')).toContain('中身が見つかりません');
  });

  it('🔴 zip として開けなかったときも、掴んだ窓を閉じる', async () => {
    const h = setup({ grab: 'ok', readAssetBlob: async () => new Blob(['これは zip ではない']) });
    await press(h.root);
    expect(h.closed).toBe(1);
    expect(h.picked).toBe(0);
    expect(h.status.join(' / ')).toContain('中を開けません');
  });
});
