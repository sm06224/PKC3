/** @vitest-environment happy-dom */
/**
 * 🔴 **元ファイルへ書き戻す前に、ノートとファイルの差分を確認の小窓に出す**(#1231 段②。
 * 🟣 Gemini 裁定 Q1 = A + C、Q2 = A + C。行ごとの取り込み(merge)は作らない ── **見るだけ**)。
 *
 * > 書き戻すと「ファイルの元の内容は失われます(取り消せません)」。user は**何が消えて何が書かれるか**を
 * > 知らないまま「よろしいですか?」を押していた ── 取り消せない操作の前で、いちばん実害に近い穴。
 *
 * 🔑 **ここは本物どうしを繋ぐ**: 確認は**本物の自前の小窓**(`confirmInApp`)、ファイルは
 *   **偽の handle を持つ `LaunchedFiles`**(`readCurrent` = `main.ts` が `inspectFile` へ渡す物)、
 *   書くのは `writeBackEntry`。⚠ `confirm` を stub にすると「差分が画面に出ている」を誰も見ない。
 * ⚠ `main.ts` は unit から実行されないので、配線は `write-back.test.ts` の原文 pin が見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildWriteBackDiff,
  writeBackConfirmMessage,
  writeBackEntry,
  WRITE_BACK_DIFF_MAX_ROWS,
  WRITE_BACK_SAME_NOTE,
} from '../../src/adapter/ui/actions/write-back';
import { confirmInApp, DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import {
  CHANGED_OUTSIDE_WRITE_BACK_NOTE,
  LaunchedFiles,
  type LaunchedHandle,
} from '../../src/adapter/platform/launched-files';

const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel) as T;
const dialog = (): HTMLDialogElement => q<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const okBtn = (): HTMLButtonElement => q<HTMLButtonElement>('[data-pkc-field="dialog-ok"]');
const cancelBtn = (): HTMLButtonElement => q<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]');
const diffRowsOf = (kind: string): string[] =>
  [...document.querySelectorAll(`[data-pkc-field="dialog-diff-rows"] [data-pkc-diff="${kind}"]`)].map(
    (li) => li.textContent ?? '',
  );
const tick = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** 取り込んだ時の時刻 1000、ファイルの今の中身を `text` にした偽の handle。 */
function linked(text: string | null, over: { lastModified?: number } = {}): LaunchedFiles {
  const l = new LaunchedFiles();
  const handle: LaunchedHandle = {
    kind: 'file',
    getFile: () =>
      text === null
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(new File([text], '議事録.md', { lastModified: over.lastModified ?? 1000 })),
  };
  l.remember('n1', handle, '議事録.md', 1000);
  return l;
}

/** 本物の小窓を使う `writeBackEntry`(`main.ts` の配線と同じ形)。 */
function run(launched: LaunchedFiles, body: string) {
  const written: string[] = [];
  const said: string[] = [];
  const host = document.querySelector<HTMLElement>('#host') as HTMLElement;
  const done = writeBackEntry({
    name: '議事録.md',
    settle: async () => {},
    getBody: async () => body,
    write: async (b) => {
      written.push(b);
      return { ok: true };
    },
    inspectFile: async () => (await launched.readCurrent('n1')) ?? { changed: false, text: null },
    confirm: (message, diff) =>
      confirmInApp(host, message, {
        okLabel: '書き戻す',
        cancelLabel: 'やめる',
        danger: true,
        diff: diff ?? undefined,
      }).then((a) => a === 'ok'),
    done: (m) => said.push(`done:${m}`),
    fail: (m) => said.push(`fail:${m}`),
  });
  return { done, written, said };
}

describe('書き戻す前の差分(#1231 段②)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
    resetAppDialogForTest();
  });

  it('🔴 ファイルと違えば、小窓に + / − の行が出る(書き込まれる行 / 消える行)。受ければ書く', async () => {
    const { done, written } = run(linked('# 議事録\n\n古い行\n共通\n'), '# 議事録\n\n新しい行\n共通\n');
    await tick();
    expect(dialog().open, '確認の小窓が開いていない').toBe(true);
    expect(diffRowsOf('add'), '書き込まれる行が + で出ていない').toEqual(['+ 新しい行']);
    expect(diffRowsOf('del'), '消える行が − で出ていない').toEqual(['− 古い行']);
    expect(q('[data-pkc-field="dialog-diff-summary"]').textContent).toContain('+1 −1');
    expect(okBtn().textContent).toBe('書き戻す');
    expect(cancelBtn().textContent).toBe('やめる');
    // 差分は確認の本文の上
    const body = q('[data-pkc-field="dialog-body"]');
    expect(body.firstElementChild?.getAttribute('data-pkc-field')).toBe('dialog-diff');
    expect(body.textContent).toContain(writeBackConfirmMessage('議事録.md', false));
    expect(written, '押す前に書いた').toEqual([]);
    okBtn().click();
    await done;
    expect(written).toEqual(['# 議事録\n\n新しい行\n共通\n']);
  });

  it('🔴 対照群: 「やめる」なら、差分を見ても 1 バイトも書かない', async () => {
    const { done, written, said } = run(linked('古い\n'), '新しい\n');
    await tick();
    expect(diffRowsOf('add')).toEqual(['+ 新しい']);
    cancelBtn().click();
    await done;
    expect(written, 'やめたのに書いた').toEqual([]);
    expect(said).toEqual([]);
  });

  it('🔴 同じ中身なら「違いはありません」── 行は出さず、書き戻すボタンは押せる', async () => {
    const { done, written } = run(linked('同じ\n中身\n'), '同じ\n中身\n');
    await tick();
    expect(q('[data-pkc-field="dialog-diff-summary"]').textContent).toBe(WRITE_BACK_SAME_NOTE);
    expect(WRITE_BACK_SAME_NOTE).toContain('違いはありません');
    expect(document.querySelector('[data-pkc-field="dialog-diff-rows"]'), '同じなのに行を出した').toBeNull();
    expect(okBtn().disabled, '押せない').toBe(false);
    okBtn().click();
    await done;
    expect(written).toEqual(['同じ\n中身\n']);
  });

  it('🔴 ファイルを読めなければ差分なし ── 今までどおりの確認(「違いはありません」と言わない)', async () => {
    const { done, written } = run(linked(null), '本文\n');
    await tick();
    expect(dialog().open, '読めないだけで確認が出ない').toBe(true);
    expect(
      document.querySelector('[data-pkc-field="dialog-diff"]'),
      '読めないのに差分(または「同じ」)を出した',
    ).toBeNull();
    expect(q('[data-pkc-field="dialog-body"]').textContent).toBe(writeBackConfirmMessage('議事録.md', false));
    okBtn().click();
    await done;
    expect(written).toEqual(['本文\n']);
  });

  it('🔴 外で変わっている段落と差分が、両方出る(ファイルの今の中身との差を見せる)', async () => {
    const { done } = run(linked('外で直した行\n', { lastModified: 2000 }), 'ノートの行\n');
    await tick();
    const text = q('[data-pkc-field="dialog-body"]').textContent ?? '';
    expect(text, '外で変わったのに段落が無い').toContain(CHANGED_OUTSIDE_WRITE_BACK_NOTE);
    expect(diffRowsOf('del'), '外での直しが「消える行」に出ていない').toEqual(['− 外で直した行']);
    expect(diffRowsOf('add')).toEqual(['+ ノートの行']);
    cancelBtn().click();
    await done;
  });

  it('⚠ 差分を見せた次の確認(差分なし)に、前の差分が残らない', async () => {
    const first = run(linked('a\n'), 'b\n');
    await tick();
    cancelBtn().click();
    await first.done;
    const second = run(linked(null), 'b\n');
    await tick();
    expect(document.querySelector('[data-pkc-field="dialog-diff"]'), '前の差分が次の確認に残った').toBeNull();
    cancelBtn().click();
    await second.done;
  });
});

describe('差分の組み立て(buildWriteBackDiff)', () => {
  it('🔴 読めない(null)なら null。同じなら「違いはありません」(行なし)', () => {
    expect(buildWriteBackDiff(null, 'x')).toBeNull();
    expect(buildWriteBackDiff('x\n', 'x\n')).toEqual({ summary: WRITE_BACK_SAME_NOTE, rows: [], more: null });
    // ⚠ 空のファイルへ本文を書くのは「同じ」ではない
    expect(buildWriteBackDiff('', 'x\n')?.rows).toEqual([{ kind: 'add', text: 'x' }]);
  });

  it('🔴 字: 何の差か(+ が書き込まれる行、− が消える行)', () => {
    expect(buildWriteBackDiff('a\n', 'b\n')?.summary).toBe(
      'いまのファイルとのちがい: +1 −1(+ が書き込まれる行、− が消える行)',
    );
  });

  it('🔴 向き: − はファイルに在って消える行、+ はノートにあって書かれる行', () => {
    const d = buildWriteBackDiff('file-only\ncommon\n', 'common\nnote-only\n');
    expect(d?.rows.filter((r) => r.kind === 'del').map((r) => r.text)).toEqual(['file-only']);
    expect(d?.rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['note-only']);
  });

  it('🔴 長いときは先頭から切って「…ほか N 行」(500 行ちょうどは切らない)', () => {
    const lines = (n: number, p: string): string => Array.from({ length: n }, (_, i) => `${p}${i}\n`).join('');
    const exact = buildWriteBackDiff('', lines(WRITE_BACK_DIFF_MAX_ROWS, 'n'));
    expect(exact?.rows).toHaveLength(WRITE_BACK_DIFF_MAX_ROWS);
    expect(exact?.more, 'ちょうど上限なのに切った').toBeNull();
    const over = buildWriteBackDiff('', lines(WRITE_BACK_DIFF_MAX_ROWS + 37, 'n'));
    expect(over?.rows).toHaveLength(WRITE_BACK_DIFF_MAX_ROWS);
    expect(over?.rows[0]).toEqual({ kind: 'add', text: 'n0' });
    expect(over?.more).toBe('…ほか 37 行');
  });

  it('🔴 切った先に「畳み」が在っても、畳んだ行数ぶんを数える(畳み 1 つを 1 行と数えない)', () => {
    // 変更 130 個(間に同じ行 2 つ)→ 同じ行 30 → 変更 20 個。変更は行ごとに − と + の 2 行になる
    const from: string[] = [];
    const to: string[] = [];
    for (let i = 0; i < 130; i++) {
      from.push(`o${i}`, `sx${i}a`, `sx${i}b`);
      to.push(`n${i}`, `sx${i}a`, `sx${i}b`);
    }
    for (let i = 0; i < 30; i++) {
      from.push(`g${i}`);
      to.push(`g${i}`);
    }
    for (let i = 0; i < 20; i++) {
      from.push(`p${i}`, `sy${i}a`, `sy${i}b`);
      to.push(`q${i}`, `sy${i}a`, `sy${i}b`);
    }
    const d = buildWriteBackDiff(from.join('\n') + '\n', to.join('\n') + '\n');
    expect(d?.rows).toHaveLength(WRITE_BACK_DIFF_MAX_ROWS);
    expect(
      d?.rows.some((r) => r.kind === 'gap'),
      '切った手前に畳みが在る(前提が崩れている)',
    ).toBe(false);
    // 全体で言い表される行 = ファイルの行 480 + 書き込まれる行 150(= 変更 150 個)
    expect(d?.more).toBe(`…ほか ${480 + 150 - WRITE_BACK_DIFF_MAX_ROWS} 行`);
  });
});
