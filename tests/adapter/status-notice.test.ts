/** @vitest-environment happy-dom */
/**
 * 🔴 **画面下の知らせを、メッセージにも残す**(#1017 C5 段 b1)。
 *
 * 守るのは:
 * ① 積む / 積まないの判断(`status-notice.ts`)── 空の字・進行中の字・`post: false` は積まない /
 *    既定は「結果」/ 同じ「注意 / 問題」は 1 セッションに 1 回
 * ② **本物の `MessagePost`** に繋いだとき ── 結果は未読を増やさず、注意 / 問題は増やし、
 *    空の字は 1 件も書かれず、二重(積んだ字をもう 1 度 `showStatus`)は 1 件のまま
 * ③ 🔴 **1 回の操作で書き込む量**と、**頭打ちになること**(実際の worker で測る → 下の 3 つ目の describe)
 *
 * ⚠ 守っていないもの:`main.ts` の配線(`showStatus` が `postStatus` を呼ぶこと / `{ post: false }` を
 *   付けた 3 か所)── `main.ts` はどの test からも走らないので原文で pin する(弱い。変異試験で見た)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MessagePost, type MessageSpool, type SpoolItem } from '../../src/adapter/platform/message-post';
import { VIEW_WINDOW_OPENING } from '../../src/adapter/platform/view-window';
import {
  createStatusPoster,
  isProgressNotice,
  shouldPostNotice,
} from '../../src/adapter/ui/render/status-notice';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusMessages } from '../../src/adapter/ui/render/status-open';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';

class FakeSpool implements MessageSpool {
  async list(): Promise<ReadonlyArray<{ id: number; item: SpoolItem }>> {
    return [];
  }
  async push(): Promise<void> {}
  async remove(): Promise<void> {}
}

type Posted = { kind: string; source: string; text: string };
const collect = (): { posted: Posted[]; poster: ReturnType<typeof createStatusPoster> } => {
  const posted: Posted[] = [];
  return { posted, poster: createStatusPoster((m) => void posted.push(m)) };
};

/** 実際に進行中として出している字(全部)。⚠ 足したらここへも足す(下の走査が漏れを見つける)。 */
const REAL_PROGRESS_TEXTS = [
  VIEW_WINDOW_OPENING, // view-window.ts(`OP_NOTICE` 経由で結果として積まれていた)
  '書き出しています…',
  '閲覧用 HTML を書き出しています…',
  'Markdown を書き出しています…',
  'Word で書き出しています…',
  '可搬 HTML を書き出しています…',
  '取込中…(ファイルを読んでいます)',
  '取込中…(12 件を書き込んでいます)',
  '切り出しています…',
  '「録音.wav」を文字にしています…(標準の部品)',
  '外部の画像 3 枚を取りに行っています…',
  '自分のパソコンで動かす一式を組んでいます…',
];

/** 結果として積む字(対照群)。⚠ 進行中に見えて結果のもの(`…` を含まない)を混ぜる。 */
const RESULT_TEXTS = [
  'コピーしました',
  '取込完了: 12 件',
  '書き出しました: 一式.pkc3-full.zip',
  '「録音.wav」に文字起こしを足しました(3 秒)',
  '可搬 HTML を書き出しました(添付 2 件)',
  '一式を組めませんでした: 失敗',
];

describe('進行中の字を見分ける(結果として積まない)', () => {
  it.each(REAL_PROGRESS_TEXTS)('🔴 進行中: %s', (t) => {
    expect(isProgressNotice(t), `進行中と読めていない: ${t}`).toBe(true);
    expect(shouldPostNotice(t)).toBe(false);
  });

  it.each(RESULT_TEXTS)('対照群(結果は積む): %s', (t) => {
    expect(isProgressNotice(t)).toBe(false);
    expect(shouldPostNotice(t)).toBe(true);
  });

  it('🔴 空の字・空白だけの字は積まない', () => {
    expect(shouldPostNotice('')).toBe(false);
    expect(shouldPostNotice('  \n ')).toBe(false);
  });

  /**
   * 🔴 **進行中の字を足した人が、形を外さない**ための門。⚠ 上の一覧は**手で書いた**ので、
   *   新しい進行中の字を足してもこの一覧は動かない ── だから `notify` / `showStatus` へ直に渡す
   *   字面を走査し、`…` を含むものが**全部**進行中と読めることを見る。
   *   外れたら「書き方を直す」か、結果なら `…` を使わない。
   */
  it('🔴 notify / showStatus へ直に渡す `…` つきの字は、全部が進行中と読める', () => {
    const files = [
      'src/main.ts',
      'src/adapter/ui/actions/binder.ts',
      'src/adapter/ui/actions/export-archive.ts',
      'src/adapter/ui/actions/export-portable.ts',
      'src/adapter/ui/actions/import-pkc2.ts',
      'src/adapter/ui/actions/capture-trim.ts',
      'src/adapter/ui/actions/capture-transcribe.ts',
      'src/adapter/ui/actions/selfhost.ts',
    ];
    const call = /\b(?:notify|showStatus|say|tellUser)\??\.?\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
    let seen = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(call)) {
        const lit = (m[2] ?? '').replace(/\$\{[^}]*\}/g, 'X');
        if (!lit.includes('…')) continue;
        seen += 1;
        expect(isProgressNotice(lit), `${f}: 進行中の形(…で終わる / …(補足))ではない: ${lit}`).toBe(true);
      }
    }
    // ⚠ 空振り防止:走査が 1 件も拾わなければ、この門は何も見ていない(この時点で 8 件)
    expect(seen, '走査が字面を拾えていない').toBeGreaterThanOrEqual(8);
  });
});

describe('積む / 積まないの判断(createStatusPoster)', () => {
  it('🔴 既定は「結果」で、出どころは固定の語(中身を含まない)', () => {
    const { posted, poster } = collect();
    poster('コピーしました');
    expect(posted).toEqual([{ kind: 'result', source: 'status', text: 'コピーしました' }]);
  });

  it('🔴 kind を渡せば、その種類で積む(注意 / 問題)', () => {
    const { posted, poster } = collect();
    poster('保存が効きません', { kind: 'problem' });
    poster('固まりました', { kind: 'caution' });
    expect(posted.map((p) => p.kind)).toEqual(['problem', 'caution']);
  });

  it('🔴 空の字・進行中の字・`post: false` は積まない(対照:同じ呼び出しで普通の字は積む)', () => {
    const { posted, poster } = collect();
    poster('');
    poster(VIEW_WINDOW_OPENING);
    poster('もう積んだ字', { post: false });
    expect(posted, '積んではいけない字を積んだ').toEqual([]);
    poster('積む字');
    expect(posted, '対照群が積まれていない(判断が全部を弾いている)').toHaveLength(1);
  });

  it('🔴 同じ「注意 / 問題」は 1 セッションに 1 回だけ。結果は(別の操作なので)積み直す', () => {
    const { posted, poster } = collect();
    poster('壊れています', { kind: 'problem' });
    poster('壊れています', { kind: 'problem' });
    poster('コピーしました');
    poster('コピーしました');
    expect(posted.filter((p) => p.kind === 'problem')).toHaveLength(1);
    expect(posted.filter((p) => p.kind === 'result'), '結果まで 1 回に潰した').toHaveLength(2);
  });

  it('🔴 憶える数には上限が在り、古いものから忘れる(積み続けてもメモリを食わない)', () => {
    const { posted, poster } = collect();
    poster('最初の警告', { kind: 'caution' });
    for (let i = 0; i < 64; i += 1) poster(`警告 ${String(i)}`, { kind: 'caution' });
    posted.length = 0;
    poster('最初の警告', { kind: 'caution' }); // 押し出されたので、また積まれる
    expect(posted, '古いものを忘れていない').toHaveLength(1);
    poster('警告 63', { kind: 'caution' }); // 直近は憶えている
    expect(posted, '直近まで忘れた').toHaveLength(1);
  });
});

describe('本物の MessagePost に繋ぐ', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  function wire() {
    const post = new MessagePost(new FakeSpool());
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    const unread: number[] = [];
    post.onUnreadChanged((n) => unread.push(n));
    const poster = createStatusPoster((m) => post.post(m));
    const sections = (): string[] =>
      appendMessage.mock.calls.map((c) => (c[0] as { section: string }).section);
    return { post, poster, unread, sections, appendMessage };
  }

  it('🔴 ① 結果は 1 件書かれ、未読は増えない', async () => {
    const w = wire();
    w.poster('コピーしました');
    await settle();
    expect(w.sections()).toHaveLength(1);
    expect(w.sections()[0]).toContain('**結果**');
    expect(w.sections()[0]).toContain('コピーしました');
    expect(w.unread, '結果で未読が増えた').toEqual([]);
  });

  it('🔴 ② 問題は未読が 1 つ増え、同じ字をもう一度言っても増えない', async () => {
    const w = wire();
    w.poster('Office が不安定になりました', { kind: 'problem' });
    w.poster('Office が不安定になりました', { kind: 'problem' });
    await settle();
    expect(w.sections()).toHaveLength(1);
    expect(w.sections()[0]).toContain('**問題**');
    expect(w.unread).toEqual([1]);
  });

  it('🔴 ③ 空の字は 1 件も書かれない(進行中を消す `notify("")` が結果として残らない)', async () => {
    const w = wire();
    w.poster('');
    w.poster(VIEW_WINDOW_OPENING);
    // ⚠ 経路を通らず口へ直に空を撃つ呼び側が居ても、書く口(`MessagePost.post`)が止める
    w.post.post({ kind: 'result', source: 'app', text: '' });
    w.post.post({ kind: 'result', source: 'app', text: '   ' });
    await settle();
    expect(w.appendMessage, '空の節が書かれた').not.toHaveBeenCalled();
  });

  it('🔴 ④ 既に積んだ字を `post: false` で出し直しても、メッセージは 1 件のまま', async () => {
    const w = wire();
    // main.ts の `reservedLockCaution` / `quotaCaution` と同じ形:先に積み、画面へは post:false
    w.post.post({ kind: 'caution', source: 'storage', text: '空きが少なくなっています' });
    w.poster('空きが少なくなっています', { post: false });
    await settle();
    expect(w.sections()).toHaveLength(1);
  });

  it('🔴 ⑤ 括弧の中身(題名・ファイル名)は潰されて書かれる ── 引用符で囲んだ字は漏れない', async () => {
    const w = wire();
    w.poster('取り込みました:『秘密の計画』');
    w.poster('書き戻しました: 「給与.xlsx」');
    await settle();
    const all = w.sections().join('');
    expect(all).toContain('『…』');
    expect(all).toContain('「…」');
    expect(all, '題名が残った').not.toContain('秘密の計画');
    expect(all, 'ファイル名が残った').not.toContain('給与');
  });
});

describe('main.ts の配線(原文 pin ── 弱い。`main.ts` は走らないため)', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');

  it('🔴 showStatus は積む口(postStatus)を通り、積んだ字の出し直しは post:false', () => {
    expect(code).toMatch(/const showStatus = \(text: string, opts\?: StatusOptions\) => \{\s*postStatus\(text, opts\);/);
    expect(code).toContain('showStatus(state.notice, { post: false })');
    expect(code).toContain('showStatus(lockCaution.text, { post: false })');
    expect(code).toContain('showStatus(caution.text, { post: false })');
  });

  it('🔴 OP_NOTICE の枝は、空の字と進行中の字を積まない', () => {
    expect(code).toMatch(/if \(shouldPostNotice\(state\.notice\)\)\s*\n\s*appMessagePost\.post\(\{ kind: 'result', source: 'app', text: state\.notice \}\)/);
  });

  it('🔴 断り・エラーの直呼びは kind を渡している(5 か所)', () => {
    expect(code).toMatch(/onBroken: \(text\) => showStatus\(text, \{ kind: 'problem' \}\)/);
    expect(code.match(/kind: 'caution'/g)?.length, 'caution の渡し先が 2 つ(PDF が読めなかった / Office が固まった)').toBe(2);
    expect(code.match(/kind: 'problem'/g)?.length, 'problem の渡し先が 3 つ(壊れ / 一式 / Office)').toBeGreaterThanOrEqual(3);
  });
});

describe('ファイル名・題名は引用符で囲む(原文 pin ── `main.ts` / `binder.ts` は走らないため。弱い)', () => {
  /**
   * 🔴 `sanitizeMessageText` が潰すのは「…」『…』の中身だけ ── 囲まない名前は**そのまま残る**。
   * ⚠ 字を直接見る test が在る所(write-back / capture-trim / office-save-back / copy-md-block /
   *   attach / office-launch)はそちらが `sanitizeMessageText` を通して見ている。ここは走らない 2 file。
   */
  const strip = (f: string): string =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

  it('🔴 main.ts: 取り込んだ題名 / Office のファイル名は囲んである', () => {
    const code = strip('src/main.ts');
    expect(code).toContain('保存すると残ります:『${input.title}』');
    expect(code).toContain('から 1 件取り込みました:『${input.title}』');
    expect(code).toContain('`「${staged.name}」を開いています');
    expect(code).toContain('`「${last.file.name}」を開けます');
  });

  it('🔴 binder.ts: zip から取り出せなかったファイル名は囲んである', () => {
    expect(strip('src/adapter/ui/actions/binder.ts')).toContain('bad.push(`「${outName}」(${why(err)})`)');
  });
});

describe('「未読 N 件」の押し口', () => {
  function setup() {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const d = new Dispatcher();
    const sent: Dispatchable[] = [];
    const raw = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      sent.push(a);
      return raw(a);
    }) as typeof d.dispatch;
    bindActions(root, d);
    return { regions, sent };
  }

  it('🔴 未読 0 では出ない・字も空', () => {
    const { regions } = setup();
    paintStatusMessages(regions.statusMessages, 0);
    expect(regions.statusMessages.hidden).toBe(true);
    expect(regions.statusMessages.textContent, '畳んだ口に字が残っている').toBe('');
  });

  it('🔴 未読 2 では「未読 2 件」が出て、0 に戻れば畳む(対照:出るのは未読があるときだけ)', () => {
    const { regions } = setup();
    paintStatusMessages(regions.statusMessages, 2);
    expect(regions.statusMessages.hidden).toBe(false);
    expect(regions.statusMessages.textContent).toBe('未読 2 件');
    paintStatusMessages(regions.statusMessages, 0);
    expect(regions.statusMessages.hidden).toBe(true);
  });

  it('🔴 押すと open-messages の受け手へ届き、メッセージのノートを開く(既読にする)', () => {
    const { regions, sent } = setup();
    paintStatusMessages(regions.statusMessages, 2);
    expect(regions.statusMessages.getAttribute('data-pkc-action')).toBe('open-messages');
    regions.statusMessages.click();
    expect(sent).toContainEqual({ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID });
  });
});

describe('画面下の帯は読み上げに届く', () => {
  it('🔴 role=status / aria-live=polite / aria-atomic=false(隣の押し口まで読み直さない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    expect(regions.status.getAttribute('role')).toBe('status');
    expect(regions.status.getAttribute('aria-live')).toBe('polite');
    // ⚠ role=status は atomic=true を含意する ── 明示しないと、変わるたびに「そのノートを開く」等まで読む
    expect(regions.status.getAttribute('aria-atomic')).toBe('false');
  });
});
