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
import { appPhone } from '../../src/adapter/ui/render/phone-layout';

/** 中身のある zip(実物の目録を読ませる ── 作り物の rows を渡さない)。 */
async function zipBlob(): Promise<Blob> {
  const bytes = await buildZip([
    { name: '写真/海.jpg', bytes: bytesOf('umi') },
    { name: 'readme.txt', bytes: bytesOf('hello') },
  ]);
  return new Blob([bytes as unknown as BlobPart]);
}

/** 中身が 1 件も無い書庫。⚠ フォルダだけの zip は**行が出る**ので、ここは空にする。 */
async function emptyZipBlob(): Promise<Blob> {
  const bytes = await buildZip([]);
  return new Blob([bytes as unknown as BlobPart]);
}

interface Harness {
  root: HTMLElement;
  status: string[];
  grabbed: string[];
  picked: number;
  closed: number;
  /** 窓の中に出した理由。 */
  failed: string[];
  /** `attachFiles` に渡った**入れ先**(`undefined` = 名指ししていない)。 */
  into: (string | null | undefined)[];
  dispatcher: Dispatcher;
  /** 別の窓が「選んだ」ことにする(既定は「やめる」)。 */
  answer: string[] | null;
}

const meta = (lid: string, archetype: string) => ({
  lid,
  title: `t-${lid}`,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function setup(
  over: Partial<BinderServices> & { grab?: 'ok' | 'blocked'; reused?: boolean },
): Harness {
  const root = document.createElement('div');
  root.innerHTML =
    '<button data-pkc-action="browse-archive" data-pkc-asset-key="k1" ' +
    'data-pkc-asset-name="書庫.zip">中を見る</button>';
  document.body.append(root);
  const dispatcher = new Dispatcher();
  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('zip1', 'attachment'), meta('other', 'text')],
    relations: [],
  });
  dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'zip1' });
  const h: Harness = {
    root,
    status: [],
    grabbed: [],
    picked: 0,
    closed: 0,
    failed: [],
    into: [],
    dispatcher,
    answer: null,
  };
  const services: BinderServices = {
    showStatus: (t) => h.status.push(t),
    readAssetBlob: async () => zipBlob(),
    attachFiles: (_files, _why, _at, intoLid) => h.into.push(intoLid),
    ...(over.grab === undefined
      ? {}
      : {
          grabArchiveWindow: (_title, key) => {
            h.grabbed.push(key);
            if (over.grab === 'blocked') return null;
            return {
              reused: over.reused ?? false,
              pick: async () => {
                h.picked += 1;
                return h.answer;
              },
              fail: (text: string) => {
                h.closed += 1;
                h.failed.push(text);
              },
            };
          },
        }),
    ...over,
  };
  bindActions(root, dispatcher, services);
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

  /**
   * 🔴 **入れ先は「押した瞬間のノート」**(#826 の着地前レビュー、動線側の欠陥 1)。
   *
   * ⚠ 直す前はここが `selectedLid` の読み直しだった ── **周りを止めるのをやめた**ので、
   *   別の窓で選んでいる間に user が主の窓で別のノートへ移ると、
   *   **取り出した物が別のノートへ入り、その本文まで書き換わる**。
   * ⚠ その場の器(modal)は、周りを止めることで**入れ先の身元**も守っていた
   *   (CLAUDE.md §10「置き換えられる側が"ついでに"提供していた性質」)。
   */
  it('🔴 選んでいる間にノートを移っても、押したときのノートへ入る', async () => {
    const h = setup({ grab: 'ok' });
    h.answer = ['readme.txt'];
    // ⚠ **選ばせている最中に**主の窓で別のノートへ移る(別の窓は画面を止めない)
    h.root.querySelector<HTMLButtonElement>('[data-pkc-action="browse-archive"]')!.click();
    h.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    expect(h.into, '入れ先を名指ししていない(いま選んでいるノートへ入る)').toEqual(['zip1']);
  });

  /** ⚠ 対照群 ── 移らなければ、いま選んでいるノートと同じである(名指しが常に嘘でない)。 */
  it('移らなければ、押したノート = いま選んでいるノート', async () => {
    const h = setup({ grab: 'ok' });
    h.answer = ['readme.txt'];
    await press(h.root);
    expect(h.into).toEqual(['zip1']);
    expect(h.dispatcher.getState().selectedLid).toBe('zip1');
  });

  it('🔴 中身が読めなかったら、掴んだ窓を閉じる(「読んでいます…」を残さない)', async () => {
    const h = setup({ grab: 'ok', readAssetBlob: async () => null });
    await press(h.root);
    expect(h.closed, '読めなかったのに窓が残っている').toBe(1);
    expect(h.picked, '読めていないのに一覧を組んだ').toBe(0);
    expect(h.status.join(' / ')).toContain('中身が見つかりません');
  });

  it('🔴 zip として開けなかったときも、理由を窓の中に出す', async () => {
    const h = setup({ grab: 'ok', readAssetBlob: async () => new Blob(['これは zip ではない']) });
    await press(h.root);
    expect(h.closed).toBe(1);
    expect(h.picked).toBe(0);
    expect(h.status.join(' / ')).toContain('中を開けません');
    // 🔴 **窓の中にも同じ理由**(user は開いた窓を見ている)
    expect(h.failed.join(' / '), '窓の中に理由が出ていない').toContain('中を開けません');
  });

  /** ⚠ 中身が 1 件も無い書庫でも、窓を残さず理由を出す(3 つ目の早期 return)。 */
  it('取り出せる物が無い書庫でも、理由を窓の中に出す', async () => {
    const h = setup({ grab: 'ok', readAssetBlob: async () => emptyZipBlob() });
    await press(h.root);
    expect(h.picked, '中身が無いのに一覧を組んだ').toBe(0);
    expect(h.failed.join(' / ')).toContain('取り出せる物がありません');
  });

  /**
   * 🔴 **2 回目は前へ出すだけ**(#826 の着地前レビュー 欠陥 2)。
   * ⚠ 読み直して組み直すと、user が付けた印が全部消える。
   */
  it('🔴 もう同じ書庫を映している窓は、読み直さない', async () => {
    const h = setup({ grab: 'ok', reused: true });
    await press(h.root);
    expect(h.picked, '組み直している(印が消える)').toBe(0);
    expect(h.status.join(' / ')).toContain('別の窓に出ています');
  });

  /**
   * 🔴 **電話の画面では、選ばれていても この画面**(着地前レビュー 欠陥 7)。
   * ⚠ 窓は**開けてしまう**ので、塞がれたときの退避では拾えない ── 開く前に決める。
   */
  it('🔴 電話の画面では、別の窓を選んでいてもこの画面で開く', async () => {
    vi.spyOn(appPhone, 'isPhone').mockReturnValue(true);
    const h = setup({ grab: 'ok' });
    await press(h.root);
    expect(h.grabbed, '電話なのに別の窓を掴んだ').toEqual([]);
    expect(dialogOpen()).toBe(true);
    // ⚠ 電話の人に「開けませんでした」と言わない(選んだ結果でも塞がれた結果でもない)
    expect(h.status.join(' / ')).not.toContain('別の窓が開けなかった');
  });

  /** ⚠ 塞がれた回の断り文は、**戻し方**まで書く(押すたび読む人が居る)。 */
  it('塞がれた断り文に、設定で選べることを書く', async () => {
    const h = setup({ grab: 'blocked' });
    await press(h.root);
    expect(h.status.join(' / ')).toContain('開く場所');
  });
});
