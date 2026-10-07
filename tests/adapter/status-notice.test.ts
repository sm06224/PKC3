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
import { EXPORT_STARTING } from '../../src/adapter/ui/actions/export-archive';
import { VIEW_WINDOW_OPENING } from '../../src/adapter/platform/view-window';
import {
  createStatusPoster,
  isProgressNotice,
  shouldPostNotice,
} from '../../src/adapter/ui/render/status-notice';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusText, type StatusLineParts } from '../../src/adapter/ui/render/status-line';
import { paintStatusMessages } from '../../src/adapter/ui/render/status-open';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { SYSTEM_MESSAGE_LID, sanitizeMessageText } from '../../src/features/message/message-log';
import { attachmentNameRewriteNotice } from '../../src/features/markdown/body-rewrite';

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
  // ⚠ 書き出しの開始の字は**実装の定数**を読む(`EXPORT_STARTING`)── 手で写すと、実装から `…` を落としても動かない
  ...Object.values(EXPORT_STARTING),
  'Word で書き出しています…',
  '1 ファイルの HTML を書き出しています…',
  '取り込み中…(ファイルを読んでいます)',
  '取り込み中…(12 件を書き込んでいます)',
  '切り出しています…',
  '「録音.wav」を文字にしています…(標準の部品)',
  '外部の画像 3 枚を取りに行っています…',
  '自分のパソコンで動かす zip を作っています…',
];

/** 結果として積む字(対照群)。⚠ 進行中に見えて結果のもの(`…` を含まない)を混ぜる。 */
const RESULT_TEXTS = [
  'コピーしました',
  '取り込み完了: 12 件',
  '書き出しました: 一式.pkc3-full.zip',
  '「録音.wav」に文字起こしを足しました(3 秒)',
  '1 ファイルの HTML を書き出しました(添付 2 件)',
  '自分のパソコンで動かす zip を作れませんでした: 失敗',
  // 🔴 `…` を**途中に**含む結果(題名の中の `…`)── 進行中の形(末尾の `…` / `…(補足)`)ではない。
  //    ⚠ 結果の字に `…` が 1 件も無いと、進行中の見分けを `/…/` に広げても対照群が鳴らない
  '「どうしよう…」を保存しました',
  '「あとで…」に 3 件入れました(5 秒)',
];

describe('進行中の字を見分ける(結果として積まない)', () => {
  it.each(REAL_PROGRESS_TEXTS)('🔴 進行中: %s', (t) => {
    expect(isProgressNotice(t), `進行中と読めていない: ${t}`).toBe(true);
    expect(shouldPostNotice(t)).toBe(false);
  });

  it('🔴 書き出しの開始の字(実装の定数)は 3 種とも在り、全部が進行中と読める', () => {
    // ⚠ 手で写した一覧ではなく定数そのものを見る ── 実装から `…` を落とすと、ここが落ちる
    expect(Object.keys(EXPORT_STARTING).sort()).toEqual(['archive', 'html', 'markdown']);
    for (const t of Object.values(EXPORT_STARTING)) {
      expect(isProgressNotice(t), `進行中と読めていない: ${t}`).toBe(true);
    }
  });

  it('🔴 結果の対照群に、`…` を途中に含む字が 1 件以上在る(進行中の見分けを広げすぎたら鳴る)', () => {
    expect(RESULT_TEXTS.some((t) => t.includes('…') && !t.endsWith('…')), '対照群に途中の … が無い').toBe(true);
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

  it('🔴 既読にしたら憶えた字を忘れる(読んだ後の再発は新しい出来事 ── 2 回目も積む)', () => {
    const posted: Posted[] = [];
    let read: () => void = () => {};
    const poster = createStatusPoster(
      (m) => void posted.push(m),
      (onRead) => {
        read = onRead;
      },
    );
    poster('Office が不安定になりました', { kind: 'problem' });
    poster('Office が不安定になりました', { kind: 'problem' });
    expect(posted, '前提: 既読の前は 1 回だけ').toHaveLength(1);
    read();
    poster('Office が不安定になりました', { kind: 'problem' });
    expect(posted, '既読の後の同じ警告が積まれていない').toHaveLength(2);
    // 対照:既読にしなければ(もう一度同じ字を言っても)増えない
    poster('Office が不安定になりました', { kind: 'problem' });
    expect(posted, '既読にしていないのに重ねて積んだ').toHaveLength(2);
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

describe('本物の MessagePost につなぐ', () => {
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

  it('🔴 ②b 既読にしたあと同じ警告がもう一度来たら、積まれて未読も増える(本物の MessagePost)', async () => {
    const post = new MessagePost(new FakeSpool());
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    const unread: number[] = [];
    post.onUnreadChanged((n) => unread.push(n));
    // main.ts と同じ繋ぎ:未読が 0 になったら憶えを空にする
    const poster = createStatusPoster(
      (m) => post.post(m),
      (onRead) => post.onUnreadChanged((n) => { if (n === 0) onRead(); }),
    );
    poster('Office が不安定になりました', { kind: 'problem' });
    post.markRead();
    poster('Office が不安定になりました', { kind: 'problem' });
    await settle();
    expect(appendMessage, '2 回目が積まれていない').toHaveBeenCalledTimes(2);
    expect(unread).toEqual([1, 0, 1]);
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
    // 🔴 画面下の出し方(寿命・進行中の欄)は `createStatusNotices` が持ち、積む口はそこへ渡す(#1017 C5 Q1〜Q3)
    expect(code).toMatch(/statusNotices = createStatusNotices\(\{\s*post: postStatus,/);
    expect(code).toContain('const showStatus = (text: string, opts?: StatusOptions): void => statusNotices!.show(text, opts);');
    expect(code).toContain('showStatus(state.notice, { post: false })');
    expect(code).toContain('showStatus(lockCaution.text, { post: false })');
    expect(code).toContain('showStatus(caution.text, { post: false })');
  });

  it('🔴 OP_NOTICE の枝は、空の字と進行中の字を積まない', () => {
    expect(code).toMatch(/if \(shouldPostNotice\(state\.notice\)\)\s*\n\s*appMessagePost\.post\(\{ kind: 'result', source: 'app', text: state\.notice \}\)/);
  });

  it('🔴 断り・エラーの直呼びは kind を渡している(5 か所)', () => {
    expect(code).toMatch(/onBroken: \(text\) => showStatus\(text, \{ kind: 'problem' \}\)/);
    expect(code.match(/kind: 'caution'/g)?.length, 'caution の渡し先が 4 つ(PDF が読めなかった / Office が固まった / 読み込めなかった / 控えを書けなかった)').toBe(4);
    expect(code.match(/kind: 'problem'/g)?.length, 'problem の渡し先が 3 つ(壊れ / 一式 / Office)').toBeGreaterThanOrEqual(3);
  });
});

describe('🔴 失敗・断りの字は「注意」で積む(原文 pin ── 弱い。着地後レビュー ⚠3)', () => {
  const strip = (f: string): string =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

  it('🔴 main.ts: 読み込めなかった / 控えを書けなかったは caution', () => {
    const code = strip('src/main.ts');
    expect(code).toContain("showStatus('コピーできませんでした', { kind: 'caution' })");
    expect(code).toContain("showStatus(shadowFailedNotice(ev.reason), { kind: 'caution' })");
  });

  it('🔴 対照:user が「やめる」を選んだ結果(OFFICE_DECLINED_NOTICE)は結果のまま(kind を渡さない)', () => {
    const code = strip('src/main.ts');
    expect(code).toContain('showStatus(OFFICE_DECLINED_NOTICE);');
  });

  it('🔴 capture.ts / timer.ts: 取り込めなかった / 本文に入れていないは caution', () => {
    expect(strip('src/adapter/ui/actions/capture.ts')).toMatch(
      /を取り込めませんでした`, \{ kind: 'caution' \}\)/,
    );
    expect(strip('src/adapter/ui/actions/timer.ts')).toMatch(
      /が見つからないので本文に入れていません\(\$\{what\}\)`, \{ kind: 'caution' \}\)/,
    );
  });

  it('🔴 main.ts: 状態の行の字の器へ textContent で書かない(読み上げの子 status-live ごと消える)', () => {
    expect(strip('src/main.ts')).not.toMatch(/regions\.statusText\.textContent\s*=/);
  });

  it('🔴 既読の合図を createStatusPoster へ渡している(未読が 0 になったら憶えを空にする)', () => {
    expect(strip('src/main.ts')).toMatch(
      /createStatusPoster\(\s*\(m\) => appMessagePost\.post\(m\),\s*\(onRead\) => appMessagePost\.onUnreadChanged\(\(n\) => \{ if \(n === 0\) onRead\(\); \}\)/,
    );
  });
});

describe('添付名は「」で囲んで積む(積むとき中身が潰れる)', () => {
  it('🔴 添付名の書き換えの知らせは、素の名前を残さずに積まれる', () => {
    const text = attachmentNameRewriteNotice('scan.pdf', '請求書.pdf');
    const posted = sanitizeMessageText(text);
    expect(posted, '添付名が積まれた記録に残った').not.toContain('scan.pdf');
    expect(posted).not.toContain('請求書');
    // 対照:何が起きたかの字は残る
    expect(posted).toBe('ファイル名を「…」→「…」にしました');
    // 画面に出る字は名前を言う(元と新しい名前を見せる)
    expect(text).toBe('ファイル名を「scan.pdf」→「請求書.pdf」にしました');
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
    // ⚠ 取り込んだ題名の知らせは、外から作る 1 本(#1407)へ移った ── 字はそちらで囲んでいる
    const outside = strip('src/adapter/transport/outside-create.ts');
    expect(outside).toContain('保存すると残ります:『${title}』');
    expect(outside).toContain('から 1 件取り込みました:『${title}』');
    expect(outside).toContain('がノートを作りました:『${title}』');
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

describe('画面下の帯は読み上げに届く(知らせとエラーだけ)', () => {
  function shell() {
    const root = document.createElement('div');
    document.body.append(root);
    return buildShell(root);
  }
  const parts = (extra: Partial<StatusLineParts> = {}): StatusLineParts => ({
    phase: 'ready',
    statusBase: '',
    sync: '',
    portableAssetNote: '',
    persistState: '',
    savingLine: '',
    progressLine: '',
    noticeLine: '',
    errorLine: '',
    ...extra,
  });

  it('🔴 footer 全体には role / aria-live を付けない(暗黙の contentinfo を残す)', () => {
    const regions = shell();
    expect(regions.status.tagName).toBe('FOOTER');
    expect(regions.status.hasAttribute('role'), 'footer に role を付けた(contentinfo が消える)').toBe(false);
    expect(regions.status.hasAttribute('aria-live'), 'footer 全体が読み上げ対象になっている').toBe(false);
  });

  it('🔴 読み上げの子(status-live)は 1 つだけ在り、polite で、起動の時点で存在する', () => {
    const regions = shell();
    const lives = regions.status.querySelectorAll('[aria-live]');
    expect(lives, '読み上げの要素が 1 つではない').toHaveLength(1);
    const live = lives[0]!;
    expect(live.getAttribute('data-pkc-field')).toBe('status-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(regions.statusText.contains(live)).toBe(true);
  });

  it('🔴 保存中・状態語・保存先の注意の出入りでは、読み上げの子の字は変わらない / 知らせが来ると変わる', () => {
    const regions = shell();
    const live = regions.status.querySelector('[data-pkc-field="status-live"]') as HTMLElement;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(live, { childList: true, characterData: true, subtree: true });
    // 保存中 / 編集中 / 保存先の注意 が出入りする
    paintStatusText(regions.statusText, parts({ savingLine: '⏳ 保存中…' }));
    paintStatusText(regions.statusText, parts({ phase: 'editing', statusBase: '保存先の注意' }));
    paintStatusText(regions.statusText, parts({ phase: 'editing', savingLine: '⏳ 保存中…' }));
    paintStatusText(regions.statusText, parts());
    records.push(...mo.takeRecords());
    expect(records, '状態語・保存中の出入りで読み上げの子が書き換わった').toHaveLength(0);
    expect(live.textContent).toBe('');
    // 知らせが来ると、その字が入る
    paintStatusText(regions.statusText, parts({ savingLine: '⏳ 保存中…', noticeLine: 'コピーしました' }));
    expect(live.textContent, '知らせが読み上げの子に入っていない').toBe('コピーしました');
    // 同じ知らせのまま保存中だけ出入りしても、読み上げの子は書き換わらない(同じ要素を使い続ける)
    mo.takeRecords();
    paintStatusText(regions.statusText, parts({ noticeLine: 'コピーしました' }));
    paintStatusText(regions.statusText, parts({ savingLine: '⏳ 保存中…', noticeLine: 'コピーしました' }));
    expect(mo.takeRecords(), '知らせが同じなのに読み上げの子が書き換わった').toHaveLength(0);
    expect(regions.statusText.querySelector('[data-pkc-field="status-live"]'), '読み上げの子が作り直された').toBe(live);
    // エラーも読み上げの子へ
    paintStatusText(regions.statusText, parts({ errorLine: '⚠ エラー: 失敗' }));
    expect(live.textContent).toBe('⚠ エラー: 失敗');
    mo.disconnect();
  });
});
