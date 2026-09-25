/** @vitest-environment happy-dom */
/**
 * 🔴 **中身を残して作り直す口の、画面の側**(#1006)。
 *
 * ## user が求めていたこと(2026-09-18、こちらの解釈)
 *
 * 壊れているのは **DB の側**なのに、直す口が「**全部捨てる**」しか無かった ──
 * なぜ中身まで捨てさせられるのか、という問いである。
 * 🔑 だから**中身を持ち越して入れ物だけ作り直す**道を、**捨てるの上**に置いた。
 *
 * ## ⚠ ここで守るもの(順番そのものは features 側が持つ)
 *
 * ① 押しただけでは **1 件も拾いに行かない**(まず窓が出る)
 * ② 窓の字に、**この端末に在る添付の件数**が届いている(= `rescueAssets` の配線)
 * ③ 進み具合が画面に出る(「固まった」と読まれて窓を閉じられない)
 * ④ 落ちた回は **「何も消えていません」** と言い、読み込み直さない
 * ⑤ 🔴 **合言葉を聞かない** ── 捨てる側との差はここである
 *
 * 拾う → 落とす → 捨てる → 開き直す → 書き戻す、の順は
 * `tests/features/container-rebuild.test.ts` が見る。
 */
import { readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { REBUILD_LOST, type RebuildReport } from '../../src/features/storage/container-rebuild';
import { CONTAINER_REBUILD_LABEL } from '../../src/features/storage/rescue-labels';
import { DIALOG_REGION } from '../../src/adapter/ui/render/app-dialog';

const meta = (lid: string, title: string): EntryMeta =>
  ({
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  }) as EntryMeta;

/** ⚠ 小窓は `enqueue` の中の `async` なので、microtask を数周ぶん進める。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function liveDialog(): HTMLDialogElement | null {
  const all = document.querySelectorAll<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
  return [...all].find((el) => el.open) ?? null;
}

const DONE: RebuildReport = {
  outcome: 'rebuilt',
  rescued: {
    entries: 3,
    skipped: 0,
    empty: 0,
    bodyMissing: 0,
    assets: 2,
    assetBytes: 40,
    assetMissing: 0,
  },
  restored: 3,
  wiped: true,
  note: null,
  fallbackReason: null,
  error: null,
};

function mount(
  over: {
    report?: RebuildReport;
    fail?: string;
    assetKeys?: readonly string[];
    /** 🔑 `onProgress` を何回、どの字で呼ぶか(進み具合が画面へ届くかを見る)。 */
    progress?: readonly (readonly ['pick' | 'write', number])[];
    /** ⚠ 渡さなければ配線ごと落とす(= この環境では作り直せない、の対照群)。 */
    wired?: boolean;
    /** 🔑 走りっぱなしにする(連打の門を見るため ── 解くまで終わらない)。 */
    hold?: Promise<void>;
  } = {},
) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  root.append(buildSettingsCommands());
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', '一件目'), meta('b', '二件目'), meta('c', '三件目')],
    relations: [],
  });
  const calls: string[] = [];
  /**
   * ⚠ **断りの字は event ではなく state に載る**(`OP_FAILED` の reducer は
   *   `state.error` を差し替えるだけ)── `onEvent` で待つと**永久に来ない**。
   */
  const errors: string[] = [];
  let reloaded = 0;
  d.onState((st) => {
    if (st.error !== null && st.error !== undefined && st.error !== '') errors.push(st.error);
  });
  /** 🔑 **進み具合を呼ばれたその場で読む** ── 後から観測すると最後の字しか残らない。 */
  const during: string[] = [];
  const services: BinderServices = {
    ...(over.assetKeys === undefined
      ? {}
      : {
          rescueAssets: {
            listKeys: async (cid: string) => (cid === 'c1' ? [...over.assetKeys!] : []),
            get: async () => null,
          },
        }),
    ...(over.wired === false
      ? {}
      : {
          rebuildContainer: async (cid, onProgress) => {
            calls.push(cid);
            for (const [phase, seen] of over.progress ?? []) {
              onProgress?.(phase, seen, null);
              during.push(
                root.querySelector('[data-pkc-field="container-rebuild-summary"]')?.textContent ??
                  '',
              );
            }
            if (over.hold !== undefined) await over.hold;
            if (over.fail !== undefined) throw new Error(over.fail);
            return over.report ?? DONE;
          },
        }),
    reloadApp: () => {
      reloaded += 1;
    },
  };
  bindActions(root, d, services);
  return {
    root,
    calls,
    errors,
    during,
    reloaded: () => reloaded,
    run: root.querySelector<HTMLButtonElement>('[data-pkc-field="container-rebuild-run"]')!,
    summary: () =>
      root.querySelector('[data-pkc-field="container-rebuild-summary"]')?.textContent ?? '',
    summaryHidden: () =>
      root.querySelector<HTMLElement>('[data-pkc-field="container-rebuild-summary"]')?.hidden ??
      true,
    body: () => liveDialog()?.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '',
    hasPassphraseInput: () =>
      liveDialog()?.querySelector('[data-pkc-field="prompt-input"]') !== null &&
      liveDialog()?.querySelector('[data-pkc-field="prompt-input"]') !== undefined,
    answer: async (which: 'ok' | 'cancel'): Promise<void> => {
      const dialog = liveDialog();
      expect(dialog, '小窓が開いていない').not.toBeNull();
      dialog
        ?.querySelector<HTMLButtonElement>(
          `[data-pkc-field="${which === 'ok' ? 'dialog-ok' : 'dialog-cancel'}"]`,
        )
        ?.click();
      await settle();
    },
  };
}

beforeEach(async () => {
  // ⚠ 開けっぱなしの小窓を残すと、次の it の `confirmInApp` に**永久に順番が来ない**
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog')) if (d.open) d.close();
  await settle();
  document.body.innerHTML = '';
});

describe('押しても、まだ何も起きない(#1006)', () => {
  it('🔴 押した時点では 1 件も拾いに行かない ── 出るのは説明の窓だけ', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.calls, '押しただけで作り直しが走った').toEqual([]);
    expect(m.body(), '説明が出ていない').toContain('入れ物を作り直します');
  });

  it('⚠ 「やめる」を押したら、何も走らない', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('cancel');
    expect(m.calls, 'やめたのに走った').toEqual([]);
    expect(m.reloaded(), 'やめたのに読み込み直した').toBe(0);
  });

  /**
   * 🔴 **捨てる側との差はここである** ── こちらは**合言葉を聞かない**。
   * ⚠ 同じ重さの門を置くと、**推奨したい側のほうが重くなる**(user 裁定 2026-09-18 で
   *   「中身を残して、作り直す」を**上**に置いたのは、まず試してほしいからである)。
   */
  it('🔴 「始める」を押したら、合言葉を聞かずに走る', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('ok');
    expect(m.hasPassphraseInput(), '合言葉の欄が出ている(捨てる側の作法が混ざった)').toBe(false);
    expect(m.calls, 'いまの入れ物へ効いていない').toEqual(['c1']);
  });
});

describe('窓の字(#1006)', () => {
  /**
   * 🔴 **`rescueAssets` の配線を通す**(#1005 の変異試験 G1 と同じ型)。
   * ⚠ `rebuildExplainMessage` を直に呼ぶ test は別に在るが、
   *   そちらは**この配線を 1 行も通らない**。
   */
  it('🔴 この端末に在る添付の件数が、窓まで届いている', async () => {
    const m = mount({ assetKeys: ['k1', 'k2', 'k3'] });
    m.run.click();
    await settle();
    expect(m.body(), '端末の添付件数が窓に出ていない').toContain('添付したファイル 3 件');
  });

  it('⚠ 対照群 ── 数える口が無ければ、数を言わずにそう言う', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), '数えられないのに数を言っている').toContain('数えられませんでした');
  });

  it('🔴 戻らない物を、押す前に言い切る', async () => {
    expect(REBUILD_LOST.length, '戻らない物の一覧が空').toBeGreaterThan(0);
    const m = mount();
    m.run.click();
    await settle();
    for (const lost of REBUILD_LOST) {
      expect(m.body(), `戻らない物「${lost}」を言っていない`).toContain(lost);
    }
  });

  it('🔴 いま一覧に出ている件数を、窓に出す', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), 'ノートの件数が窓に出ていない').toContain('3 件のノート');
  });
});

describe('走っている間と、その後(#1006)', () => {
  /**
   * 🔴 **進み具合を画面へ出す** ── 壊れた DB を舐めるのは秒で終わらないので、
   *   何も出さないと「固まった」と読まれて**窓を閉じられる**(書き戻す前に止まる)。
   */
  it('🔴 中身を取り出している / 戻している途中が、画面に出る', async () => {
    const m = mount({
      progress: [
        ['pick', 40],
        ['write', 3],
      ],
    });
    m.run.click();
    await settle();
    await m.answer('ok');
    // ⚠ 空振り防止 ── 呼ばれた回数ぶん採れていること
    expect(m.during, '進み具合を 1 度も採れていない').toHaveLength(2);
    expect(m.during[0], '拾っている途中が画面に出ていない').toContain('中身を取り出しています… 40 件');
    expect(m.during[1], '戻している途中が画面に出ていない').toContain('ノートを戻しています… 3 件');
  });

  it('🔴 終わったら、結果を読ませてから読み込み直す', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('ok');
    // ⚠ 2 枚目(結果の窓)が出ている ── ここで読ませる
    expect(m.body(), '結果の窓が出ていない').toContain('3 件を戻しました');
    expect(m.reloaded(), '読ませる前に読み込み直した').toBe(0);
    await m.answer('ok');
    expect(m.reloaded(), '読ませた後に読み込み直していない').toBe(1);
  });

  /**
   * 🔴 **落ちたのは zip を落とす前**である(features 側が、落とせなければ捨てずに投げる)
   * ── だから「**何も消えていません**」と言い切れる。
   * ⚠ ここを「作り直せませんでした」だけにすると、user は**消えたかどうか分からない**。
   */
  it('🔴 落ちた回は「何も消えていません」と言い、読み込み直さない', async () => {
    const m = mount({ fail: '書き出せません' });
    m.run.click();
    await settle();
    await m.answer('ok');
    expect(m.errors.join('\n'), '何も消えていないことを言っていない').toContain(
      '何も消えていません',
    );
    expect(m.reloaded(), '落ちたのに読み込み直した').toBe(0);
    expect(m.summaryHidden(), '落ちたのに途中の字が残っている').toBe(true);
  });

  /**
   * 🔴 **書き戻せなかった回は、済んだ顔をしない**(`memory-only`)。
   * ⚠ ここが「N 件を戻しました」になると、**戻っていないのに安心する**。
   */
  it('🔴 開き直しが退避した回は、zip から取り込むよう案内する', async () => {
    const m = mount({
      report: {
        ...DONE,
        outcome: 'memory-only',
        restored: 0,
        fallbackReason: 'NoModificationAllowedError',
      },
    });
    m.run.click();
    await settle();
    await m.answer('ok');
    expect(m.body(), '戻っていないのに戻った顔をしている').not.toContain('3 件を戻しました');
    expect(m.body(), '取り込みへ案内していない').toContain('取り込む');
  });

  it('⚠ 配線が無い環境では、黙って何も起きない形にしない', async () => {
    const m = mount({ wired: false });
    m.run.click();
    await settle();
    expect(m.errors.join('\n'), '無言の dead click になっている').toContain(
      'この環境では作り直せません',
    );
  });
});

/**
 * 🔴 **画面の字は `features` から引く**(#986 段③ / #996)。
 * ⚠ ボタンを改名した日に、案内やマニュアルが古い字を指したまま**CI も緑**になる。
 */
describe('ボタンの字(#1006)', () => {
  it('🔴 描いたボタンの字が、定数と一致する', () => {
    const m = mount();
    expect(m.run.textContent, 'ボタンの字が定数と食い違っている').toBe(CONTAINER_REBUILD_LABEL);
  });

  /**
   * 🔴 **並びがそのまま「まず試す順」である**(user 裁定 2026-09-18)。
   * ⚠ 逆に並べると、壊れた人が**先に取り消せないほう**を読む。
   */
  it('🔴 「中身を残して、作り直す」が「中身を捨てる」より上に在る', () => {
    const m = mount();
    const box = m.root.querySelector('[data-pkc-region="container-repair"]')!;
    const order = [...box.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(order, '2 段になっていない').toEqual(['container-rebuild', 'container-reset']);
  });
});

/**
 * 🔴 **配線の原文 pin**(#1005 の G3 と同じ理由)。
 *
 * ⚠ `main.ts` は**どの test からも実行されない**ので、配線を丸ごと外しても
 *   単体は 1 件も落ちない。
 * 🔴 とくに **`terminate()` を落とすと静かに壊れる**:実ブラウザで測ると、
 *   古い worker が OPFS の Access Handle を握ったままなので、開き直しは
 *   **例外を投げずに `memory` へ退避する**(2026-09-18 実測。2 回とも同じ値)。
 *   ⚠ そうなると書き戻しても**次に開いたとき消えている**。
 */
describe('作り直しの配線(原文 pin)', () => {
  const MAIN = codeOnly(readFileSync('src/main.ts', 'utf-8'));

  it('空振り防止 ── main.ts の中身を本当に読めている', () => {
    expect(MAIN.length, 'main.ts を読めていない').toBeGreaterThan(1000);
    expect(MAIN, 'バインダへ渡す口そのものが無い').toContain('rescueEntries');
  });

  it('🔴 rebuildContainer を渡しており、開き直す前に古い worker を閉じている', () => {
    const at = MAIN.indexOf('rebuildContainer:');
    expect(at, '🔴 rebuildContainer の配線が main.ts に無い').toBeGreaterThan(0);
    // ⚠ 見るのは**その塊だけ** ── file 全体で探すと別の呼び出しに満たされる(§1)
    const block = MAIN.slice(at, at + 1600);
    const reopen = block.indexOf('reopenStorage');
    expect(reopen, 'reopenStorage を渡していない').toBeGreaterThan(-1);
    const after = block.slice(reopen, reopen + 300);
    expect(after, '🔴 古い worker を閉じずに開き直している(黙って memory へ落ちる)').toContain(
      'terminate()',
    );
    expect(after, '退避した理由を返していない(書き戻しの門が効かなくなる)').toContain(
      'fallbackReason',
    );
  });
});

/**
 * 🔴 **走っている間に、もう一度押させない**(#1006 の動線レビューが出した)。
 *
 * ⚠ 走り出すと**押せる物が 1 つも無い**ので、user は固まったと思って**もう一度押す** ──
 *   ところが窓は毎回出るので、**捨てる → 開き直す が 2 本同時に走りうる**。
 * ⚠ `disabled` では止めない(**焦点が外れる**)ので、帳簿で落とす ──
 *   🔴 ただし**黙って落とさない**:何も出さないと、この repo がいちばん嫌う
 *   **無言の dead click** になる。
 */
describe('連打(#1006)', () => {
  it('🔴 走っている間の 2 度目は、理由を言って落とす', async () => {
    /**
     * ⚠ **`null` で持たない** ── 実行器の中で入るので、tsc は呼び所で
     *   `never` まで絞ってしまう(実際に落ちた)。何もしない関数で持つ。
     */
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const m = mount({ hold: held });
    m.run.click();
    await settle();
    await m.answer('ok'); // ここから走り出す(まだ終わらない)
    expect(m.calls, '1 度目が走っていない').toEqual(['c1']);

    m.run.click();
    await settle();
    expect(m.calls, '2 本目が走った').toEqual(['c1']);
    expect(m.errors.join('\n'), '無言で落としている').toContain('いま作り直しています');

    release();
    await settle();
  });

  /**
   * ⚠ **やめた回も帳簿を戻す** ── 戻し忘れると、**二度と作り直せなくなる**
   *   (押しても「いま作り直しています」と言い続ける)。
   */
  it('🔴 やめた後は、もう一度押せる', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('cancel');
    m.run.click();
    await settle();
    expect(m.body(), 'やめた後に押しても窓が出ない').toContain('入れ物を作り直します');
  });

  it('🔴 落ちた回も、もう一度押せる', async () => {
    const m = mount({ fail: '書き出せません' });
    m.run.click();
    await settle();
    await m.answer('ok');
    m.run.click();
    await settle();
    expect(m.body(), '落ちた後に押しても窓が出ない').toContain('入れ物を作り直します');
  });
});
