/** @vitest-environment happy-dom */
/**
 * 🔴 **入れ物ごと捨てる口の、画面の側**(#986 段③)。
 *
 * ## user の裁定(2026-09-16、こちらの解釈)
 *
 * **ボタンは推奨のとおり作ってよい。ただし押したら、何が起きるかの説明と、
 * 本当に実行するかの確認を出すこと。**
 *
 * ⚠ だからここで守るのは「捨てられること」ではない ── **捨てにくいこと**である:
 * ① 押しただけでは **1 バイトも消えない**
 * ② 合言葉を打つまで実行に進めない
 * ③ 説明の字が、**測った / 定数から引いた値**で書かれている(手書きの数を残さない)
 *
 * 消す順番そのものは `tests/features/container-reset.test.ts` が見る。
 */
import { readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { buildSettingsCommands } from '../../src/adapter/ui/render/commands';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { ContainerResetReport } from '../../src/features/storage/container-reset';
import { RESET_PASSPHRASE } from '../../src/features/storage/container-reset';
import {
  forgetRescueWritten,
  noteRescueWritten,
} from '../../src/features/storage/rescue-archive';
import { OFFICE_PACK_APPROX } from '../../src/features/office/office-pack-size';
import { DUCKDB_PACK_APPROX } from '../../src/features/query/duckdb-pack';
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

const OK = { wiped: true, note: null, assets: 2, assetFailures: 0 } satisfies ContainerResetReport;

function mount(over: {
  report?: ContainerResetReport;
  fail?: string;
  /**
   * 🔴 **端末に在る添付の鍵**（#1005）。
   * ⚠ 渡さなければ `rescueAssets` ごと配線しない（= 直す前の姿の対照群）。
   */
  assetKeys?: readonly string[];
} = {}) {
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
  /** 🔑 **呼ばれた回数と引数**を採る ── 「消えなかった」を件数で言えるようにする。 */
  const calls: string[] = [];
  let reloaded = 0;
  bindActions(root, d, {
    /**
     * 🔴 **binder の配線を通す**（#1005。変異試験 G1 が SURVIVED で教えた）。
     *
     * ⚠ 直す前は `rescueAssets` をどの test も渡していなかったので
     *   （repo 全体で `grep -rln 'rescueAssets' tests/` が **0 件**）、
     *   🔴 **数える枝そのものが 1 度も実行されていなかった**
     *   （CLAUDE.md §2「経路が一度も通っていない」）。
     * ⚠ `resetExplainMessage` を**直に呼ぶ** test は別に在るが、
     *   そちらは**この配線を 1 行も通らない**。
     */
    ...(over.assetKeys === undefined
      ? {}
      : {
          rescueAssets: {
            listKeys: async (cid: string) => (cid === 'c1' ? [...over.assetKeys!] : []),
            get: async () => null,
          },
        }),
    resetContainer: async (cid: string) => {
      calls.push(cid);
      if (over.fail !== undefined) throw new Error(over.fail);
      return over.report ?? OK;
    },
    reloadApp: () => {
      reloaded += 1;
    },
  });
  return {
    root,
    d,
    calls,
    reloaded: () => reloaded,
    run: root.querySelector<HTMLButtonElement>('[data-pkc-field="container-reset-run"]')!,
    summary: () =>
      root.querySelector('[data-pkc-field="container-reset-summary"]')?.textContent ?? '',
    body: () => liveDialog()?.querySelector('[data-pkc-field="dialog-body"]')?.textContent ?? '',
    /** 開いている小窓に答える。⚠ **開いていなければ落とす**(空振り防止)。 */
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
    /** 合言葉の窓に打つ。⚠ 欄が無ければ落とす(1 枚目で止まっていたら分かる)。 */
    type: async (text: string): Promise<void> => {
      const input = liveDialog()?.querySelector<HTMLInputElement>(
        '[data-pkc-field="prompt-input"]',
      );
      expect(input, '合言葉を打つ欄が出ていない').not.toBeNull();
      if (input !== null && input !== undefined) input.value = text;
      liveDialog()?.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')?.click();
      await settle();
    },
  };
}

beforeEach(async () => {
  /**
   * 🔴 **前の it が開けっぱなしにした小窓を、必ず閉じる**(実際に踏んだ)。
   *
   * ⚠ 小窓は `enqueue` で**直列**に出る(CLAUDE.md §10「native がついでに
   *   やっていたこと」の 1 つを自前で持っている)ので、閉じないまま次の it へ
   *   進むと、**次の `confirmInApp` は永久に自分の番が来ない** ──
   *   症状は「押しても小窓が出ない」で、**製品の不具合に見える**。
   * ⚠ `innerHTML = ''` で外しても閉じたことにはならない(待ち行列は module 側)。
   */
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog')) if (d.open) d.close();
  await settle();
  document.body.innerHTML = '';
  // ⚠ module の変数なので、test どうしが影響し合わないように毎回戻す
  forgetRescueWritten();
});

describe('押しても、まだ消えない(#986 段③)', () => {
  it('🔴 押した時点では 1 バイトも消さない ── 出るのは説明の窓だけ', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.calls, '押しただけで消えた').toEqual([]);
    expect(m.body(), '説明が出ていない').toContain('元に戻せません');
  });

  it('🔴 説明に「消えるもの」と「残るもの」が両方ある', async () => {
    const m = mount();
    m.run.click();
    await settle();
    const text = m.body();
    expect(text, '消えるものを言っていない').toContain('消えるもの');
    expect(text, '残るものを言っていない').toContain('残るもの');
    // ⚠ 件数は**画面が知っている数**(3 件を入れてある)
    expect(text, 'ノートの件数が出ていない').toContain('3 件');
    // 🔴 見えている数を「在る数」と読ませない
    expect(text, '一覧に出ていない分の断りが無い').toContain('一覧に出ていない分');
    // ⚠ 黙って他のタブを読み込み直さない
    expect(text, '他のタブのことを言っていない').toContain('他のタブ');
  });

  /**
   * 🔴 **大きさは定数から引く**(#996 の教訓の再発防止)。
   * ⚠ 期待値を手で「約 93MB」と書かない ── 書くと、**一式を焼き直した日に
   *   実装と test の両方が同じ古い字のまま緑**になる。
   */
  it('🔴 残る部品の大きさは、定数と同じ字で出る', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), 'Office の大きさが定数と違う').toContain(OFFICE_PACK_APPROX);
    expect(m.body(), 'DuckDB の大きさが定数と違う').toContain(DUCKDB_PACK_APPROX);
  });

  it('🔴 まだ拾っていなければ、そう言う(先に拾わせる)', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), '拾っていないことを言っていない').toContain('まだ拾い出していません');
  });

  /**
   * 🔴 **「書き出した」を真偽で出さない。** 壊れているときは **0 件のファイル**が
   *   書き出せてしまうので、件数をそのまま見せる。
   */
  it('🔴 拾ってあれば件数を出す ── 0 件でも「済み」と言わない', async () => {
    noteRescueWritten(
      { entries: 0, skipped: 7, empty: 3, bodyMissing: 0, assets: 0, assetBytes: 0, assetMissing: 0 },
      1,
    );
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), '拾えた件数が出ていない').toContain('この画面で拾えたのは 0 件です');
    expect(m.body(), '読めなかった数が出ていない').toContain('読み込めなかった箇所 7');
    expect(m.body(), '0 件なのに済んだ顔をしている').not.toContain('まだ拾い出していません');
  });

  /**
   * 🔴 **端末の添付の数が、binder を通って窓の字まで届くか**（#1005）。
   *
   * ⚠ 変異試験 G1 が SURVIVED で教えた穴である ──
   *   `listKeys(cid).then((k) => k.length, () => null)` を壊しても
   *   **どの test も落ちなかった**（渡していないのだから当然である）。
   * 🔑 見るのは**数そのもの** ── 3 という数は
   *   `listKeys` が返した鍵の数からしか来ない。
   * ⚠ 拾い出しはしていないので「**0 件だけです**」側になる
   *   （= このまま進むと 3 件失う、と言えていること）。
   */
  it('🔴 端末の添付の件数が、捨てる前の窓に出る', async () => {
    const m = mount({ assetKeys: ['k1', 'k2', 'k3'] });
    m.run.click();
    await settle();
    expect(m.body(), '端末の添付の件数が届いていない').toContain(
      'この端末には添付が 3 件あります',
    );
    expect(m.body(), '拾えていないのに残りが消えることを言っていない').toContain(
      '残りはここで消えます',
    );
  });

  /**
   * ⚠ **対照群** ── 口を渡さなければ添付の話をしない。
   * 🔑 これが無いと、上の test は「別の経路が 3 と書いている」場合と見分けられない。
   */
  it('⚠ 添付の口を渡さなければ、添付の話は出ない（対照群）', async () => {
    const m = mount();
    m.run.click();
    await settle();
    expect(m.body(), '渡していないのに添付の件数が出ている').not.toContain(
      'この端末には添付が',
    );
  });

  it('⚠ 1 枚目でやめたら、合言葉の窓すら出ない(対照群)', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('cancel');
    expect(liveDialog(), '2 枚目が出た').toBeNull();
    expect(m.calls, 'やめたのに消えた').toEqual([]);
  });
});

describe('合言葉(#986 段③)', () => {
  it('🔴 合言葉を打つまで消えない ── 違う字では消えない', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('ok');
    await m.type('はい');
    expect(m.calls, '合言葉が違うのに消えた').toEqual([]);
    // ⚠ 無言で断らない(何も起きない dead click を作らない)
    expect(m.d.getState().error ?? '', '断った理由が出ていない').toContain(RESET_PASSPHRASE);
  });

  /**
   * 🔴 **空のまま押しても通らない。**
   * ⚠ これは `promptInApp` に `initial` を渡していないことの門である ──
   *   渡すと、空のまま受けたときにその字が返る(= 何も打たずに合言葉が通る)。
   */
  it('🔴 何も打たずに「捨てる」を押しても通らない', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('ok');
    await m.type('');
    expect(m.calls, '何も打たずに消えた').toEqual([]);
  });

  it('🔴 合言葉が合えば、いまの入れ物を捨てる', async () => {
    const m = mount();
    m.run.click();
    await settle();
    await m.answer('ok');
    await m.type(RESET_PASSPHRASE);
    expect(m.calls, 'いまの入れ物を捨てていない').toEqual(['c1']);
  });

  /**
   * 🔴 **読ませてから読み込み直す** ── すぐ `reload` すると
   *   「消せなかった添付が N 件」を誰も読めない。
   */
  it('🔴 消せなかった添付の数を知らせてから、読み込み直す', async () => {
    const m = mount({ report: { wiped: true, note: null, assets: 1, assetFailures: 2 } });
    m.run.click();
    await settle();
    await m.answer('ok');
    await m.type(RESET_PASSPHRASE);
    // 知らせの窓が出ている(まだ読み込み直していない)
    expect(m.body(), '消せなかった数を知らせていない').toContain('2 件');
    expect(m.reloaded(), '読ませる前に読み込み直した').toBe(0);
    await m.answer('ok');
    expect(m.reloaded(), '読み込み直していない').toBe(1);
  });

  it('🔴 捨てられなかったら、黙らずに理由を出す', async () => {
    const m = mount({ fail: 'OPFS が開けない' });
    m.run.click();
    await settle();
    await m.answer('ok');
    await m.type(RESET_PASSPHRASE);
    expect(m.d.getState().error ?? '', '失敗を黙らせた').toContain('OPFS が開けない');
    expect(m.reloaded(), '失敗したのに読み込み直した').toBe(0);
  });
});

/**
 * 🔴 **拾った件数は、拾った道から来る**(#986 段③)。
 *
 * ⚠ 2026-09-21(#1017 段④b)に、この画面**専用**の拾う口
 *   (`db-rescue-archive-run` / `db-rescue-run`)を退役させた ── いまは
 *   左下の「バックアップ」が、普通に書き出せた回も**同じ状態
 *   (`noteRescueWritten`)**へ記録する(そうしないと、健全な入れ物では
 *   この画面が永久に「まだ拾い出していません」と言い続ける ──
 *   `export-archive.ts` の docstring)。
 *
 * 🔑 だから**実際の書き出しから記録まで繋がっているか**は、その書き出しを
 *   持つ `tests/adapter/export-archive.test.ts` が見る(層をまたいで
 *   同じことを 2 度見ない)。ここで見るのは
 *   **「記録さえ在れば、この画面がそれを読むか」**だけで、それは
 *   上の「まだ拾っていなければ、そう言う」/「拾ってあれば件数を出す」の
 *   2 本が既に守っている(直接 `noteRescueWritten` を呼ぶ**同じ形**)。
 */

/**
 * 🔴 **配線の原文 pin**（#1005。変異試験 G3 が SURVIVED で教えた）。
 *
 * ⚠ `main.ts` は**どの test からも実行されない**（原文を読む test しか無い）ので、
 *   🔴 `rescueAssets` の配線を丸ごと外しても **単体は 1 件も落ちない** ──
 *   実機では「拾い出しの添付が常に 0 件」になるのに、こちらの計器は 1 つも鳴らない。
 * ⚠ 原文 pin は**弱いと自覚して使う**（CLAUDE.md §2）が、**0 件よりはよい**。
 * ⚠ 注釈を落としてから見る ── さもないと**自分の解説に満たされる**（§1）。
 */
describe('拾い出しに添付の口を渡している（原文 pin）', () => {
  const MAIN = codeOnly(readFileSync('src/main.ts', 'utf-8'));

  it('空振り防止 ── main.ts の中身を本当に読めている', () => {
    expect(MAIN.length, 'main.ts を読めていない').toBeGreaterThan(1000);
    expect(MAIN, 'バインダへ渡す口そのものが無い').toContain('rescueEntries');
  });

  it('🔴 rescueAssets を渡しており、listKeys と get の両方が在る', () => {
    const at = MAIN.indexOf('rescueAssets:');
    expect(at, '🔴 rescueAssets の配線が main.ts に無い（添付が常に 0 件になる）').toBeGreaterThan(0);
    /**
     * ⚠ **見るのはその場だけ** ── file 全体で `listKeys` を探すと、
     *   片づけ（asset-gc）など**別の呼び出しに満たされる**（§1）。
     */
    const block = MAIN.slice(at, at + 200);
    expect(block, 'rescueAssets に listKeys が無い').toContain('listKeys');
    expect(block, 'rescueAssets に get が無い').toContain('get');
  });
});
