/** @vitest-environment happy-dom */
/**
 * 🔴 **メッセージ履歴で PKC3 自身のボタン名を伏せない**(#2084)。
 *
 * 守るのは:
 * ① 表(`app-fixed-text.ts`)の字が、各所の知らせの字と 1 字も違わないこと(src の実行行と突き合わせる)
 * ② `sanitizeMessageText` の終わりの通し(`fixedTail`)── 前の user の字は伏せ、後ろの案内のボタン名は残す
 * ③ 🔴 **対照**:表に無い字(user の題名・検索名・ファイル名を含む文)は今までどおり「…」に伏せる
 * ④ 本物の `MessagePost` に繋いだ `showStatus` の積み口(`createStatusPoster`)で、簡易履歴に読める字が残ること
 * ⑤ `main.ts` の配線(`OP_NOTICE` / `OP_FAILED` の積み口が表を引く)── main.ts は走らないので原文で pin する
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_FIXED_TAILS,
  APP_FIXED_TEXTS,
  APPEND_OPENED_NOTE,
  fixedPartsOfAppText,
  LAUNCH_GRANT_REVOKED_NOTICE,
  SYNC_ON_NOTICE,
  TRASH_PURGE_TAIL,
} from '../../src/features/message/app-fixed-text';
import { sanitizeMessageText } from '../../src/features/message/message-log';
import { MessagePost, type MessageSpool, type SpoolItem } from '../../src/adapter/platform/message-post';
import { createStatusPoster } from '../../src/adapter/ui/render/status-notice';

/** src の .ts を全部、コメント行を剥がし、`'…' + '…'` の継ぎを 1 つの字にして読む(コメントの字で満たされない)。 */
function srcCorpus(): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('app-fixed-text.ts')) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk('src');
  return out
    .join('\n')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')
    .replace(/'\s*\+\s*\n?\s*'/g, '');
}

describe('#2084 ① 表の字は src の知らせの字と一致する', () => {
  const corpus = srcCorpus();
  it.each(APP_FIXED_TEXTS.map((t) => [t]))('全文: %s', (t) => {
    // 表から import して使う 2 つは、使っている側の名前で見る
    if (t === SYNC_ON_NOTICE) expect(corpus).toContain('SYNC_ON_NOTICE');
    else if (t === LAUNCH_GRANT_REVOKED_NOTICE) expect(corpus).toContain('LAUNCH_GRANT_REVOKED_NOTICE');
    else expect(corpus, `知らせの字が表と違う: ${t}`).toContain(t);
  });
  it.each(APP_FIXED_TAILS.map((t) => [t]))('終わり: %s', (t) => {
    // 追記の 2 つ目は `openedNote` が後ろに足す一言との継ぎ(2 つの字がそれぞれ在ることを見る)
    if (t === `${TRASH_PURGE_TAIL})`) {
      expect(readFileSync('src/adapter/state/slices/restore.ts', 'utf8')).toContain('const tail = TRASH_PURGE_TAIL;');
      expect(readFileSync('src/adapter/state/slices/restore.ts', 'utf8')).toMatch(/\$\{tail\}\)`/);
    } else if (t.endsWith(APPEND_OPENED_NOTE) && t !== APPEND_OPENED_NOTE) {
      expect(corpus).toContain(t.slice(0, t.length - APPEND_OPENED_NOTE.length));
      expect(corpus).toContain(APPEND_OPENED_NOTE);
    } else expect(corpus, `知らせの字が表と違う: ${t}`).toContain(t);
  });
  it('表の字はどれも「」のボタン名を持ち、差し込み(${…})を持たない(表に載せる意味がある物だけ)', () => {
    for (const t of [...APP_FIXED_TEXTS, ...APP_FIXED_TAILS]) {
      expect(t, t).toMatch(/「[^「」]+」/);
      expect(t, t).not.toContain('${');
    }
  });
  it('main.ts の 2 つの知らせは表の字を使っている(字を 2 か所に書かない)', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain("showStatus(on ? SYNC_ON_NOTICE : '端末間の同期をオフにしました')");
    expect(main).toContain('showStatus(LAUNCH_GRANT_REVOKED_NOTICE)');
  });
});

describe('#2084 ② / ③ 伏せる字と残す字', () => {
  it('🔴 Issue の 3 件: 固定のボタン名がそのまま読める', () => {
    expect(sanitizeMessageText(SYNC_ON_NOTICE, ...head(SYNC_ON_NOTICE))).toBe(SYNC_ON_NOTICE);
    expect(sanitizeMessageText(LAUNCH_GRANT_REVOKED_NOTICE, ...head(LAUNCH_GRANT_REVOKED_NOTICE))).toBe(
      LAUNCH_GRANT_REVOKED_NOTICE,
    );
    const saved = '検索を保存しました: 「取引先 2026 秘密」(名前は「名前を直す」で変えられます)';
    expect(sanitizeMessageText(saved, ...head(saved))).toBe('検索を保存しました: 「…」(名前は「名前を直す」で変えられます)');
  });

  it('🔴 対照: 表が無ければ(直す前)ボタン名も伏せられていた ── この test は直す前に赤い', () => {
    expect(sanitizeMessageText(SYNC_ON_NOTICE)).toBe('端末間の同期をオンにしました。コレクションの「…」に「…」が出ます');
    expect(sanitizeMessageText(LAUNCH_GRANT_REVOKED_NOTICE)).toBe('「…」の許可を取り消しました');
  });

  it('🔴 対照: user の字は今までどおり伏せる(題名・ファイル名・タグ名・フォルダ名)', () => {
    for (const t of [
      '「秘密の計画」の許可を取り消しました', // 全文の表に似せた user の題名
      '「契約書.pdf」をコピーしました',
      '「#社外秘」のタグを付けました',
      '「人事」フォルダへ移しました',
    ]) {
      const out = sanitizeMessageText(t, ...head(t));
      expect(out, t).toContain('「…」');
      expect(out, t).not.toMatch(/秘密の計画|契約書|社外秘|人事/);
    }
  });

  it('🔴 user の字が表の終わりと同じ字を含んでも、user の字は漏れない(見えるのは表の字だけ)', () => {
    // 検索名そのものに案内の字を仕込む ── 終わりの一致は外側の案内だけに当たり、名前の中身は伏せる
    const name = '顧客A」(名前は「名前を直す」で変えられます)「顧客B';
    const t = `検索を保存しました: 「${name}」(名前は「名前を直す」で変えられます)`;
    const out = sanitizeMessageText(t, ...head(t));
    expect(out).not.toMatch(/顧客A|顧客B/);
    expect(out.endsWith('(名前は「名前を直す」で変えられます)')).toBe(true);
  });

  it('🔴 前の部分は今までどおり 80 字で切る(終わりの案内は落とさない)', () => {
    const t = `この章を『${'あ'.repeat(200)}』に切り出しました(元のノートには見出しとリンクが残ります。戻すには、見出しを右クリックして「切り出した章を元に戻す」)`;
    const out = sanitizeMessageText(t, ...head(t));
    expect(out).toBe('この章を『…』に切り出しました(元のノートには見出しとリンクが残ります。戻すには、見出しを右クリックして「切り出した章を元に戻す」)');
  });

  it('頭と終わりの両方を渡したとき、頭を優先し、残りの終わりの案内も残す', () => {
    expect(sanitizeMessageText('頭「A」中「秘密」(「B」)', '頭「A」', '(「B」)')).toBe('頭「A」中「…」(「B」)');
    // 頭が全文を覆うときは、終わりの一致があっても全文のまま
    expect(sanitizeMessageText('全「A」(「B」)', '全「A」(「B」)', '(「B」)')).toBe('全「A」(「B」)');
  });

  it('fixedPartsOfAppText: 全文 / 終わり / どれにも当たらない', () => {
    expect(fixedPartsOfAppText(SYNC_ON_NOTICE)).toEqual({ fixedHead: SYNC_ON_NOTICE });
    expect(fixedPartsOfAppText('スタックから 3 件を降ろしました(ノートは消えていません。並びを残すときは先に「スタックを保存…」を押します)')).toEqual({
      fixedTail: '(ノートは消えていません。並びを残すときは先に「スタックを保存…」を押します)',
    });
    // 🔑 長い方を当てる(短い「(「追記」で本文へ入ります)」が先に当たると、後ろの一言の扱いが変わる)
    expect(fixedPartsOfAppText(`選んだ 2 件を追記の欄に入れました(「追記」で本文へ入ります)${APPEND_OPENED_NOTE}`)).toEqual({
      fixedTail: `(「追記」で本文へ入ります)${APPEND_OPENED_NOTE}`,
    });
    expect(fixedPartsOfAppText('「議事録」をコピーしました')).toEqual({});
  });
});

/** 積み口と同じ引き方(`fixedPartsOfAppText`)で sanitize へ渡す引数を作る。 */
function head(t: string): [string, string] {
  const p = fixedPartsOfAppText(t);
  return [p.fixedHead ?? '', p.fixedTail ?? ''];
}

class FakeSpool implements MessageSpool {
  async list(): Promise<ReadonlyArray<{ id: number; item: SpoolItem }>> {
    return [];
  }
  async count(): Promise<number> {
    return 0;
  }
  async push(): Promise<void> {}
  async remove(): Promise<void> {}
}

describe('#2084 ④ showStatus の積み口 → 本物の MessagePost の簡易履歴', () => {
  function wire() {
    const post = new MessagePost(new FakeSpool());
    post.attach({ cid: 'c1', appendMessage: vi.fn().mockResolvedValue(undefined) });
    const poster = createStatusPoster((m) => post.post(m));
    return { post, poster };
  }

  it('🔴 同期オン / 許可の取り消し / 保存検索の知らせが、ボタン名を残して履歴に載る', () => {
    const w = wire();
    w.poster(SYNC_ON_NOTICE);
    w.poster(LAUNCH_GRANT_REVOKED_NOTICE);
    w.poster('検索を保存しました: 「得意先の未払い」(名前は「名前を直す」で変えられます)');
    expect(w.post.recent().map((m) => m.text)).toEqual([
      '検索を保存しました: 「…」(名前は「名前を直す」で変えられます)',
      LAUNCH_GRANT_REVOKED_NOTICE,
      SYNC_ON_NOTICE,
    ]);
  });

  it('🔴 対照: user の題名を含む知らせは伏せたまま', () => {
    const w = wire();
    w.poster('「来期の人事案」のウィンドウは再読み込みすると一覧が消えるため閉じました。もう一度「中を見る」を押してください');
    w.poster('「来期の人事案」をコピーしました');
    const texts = w.post.recent().map((m) => m.text);
    expect(texts).toEqual([
      '「…」をコピーしました',
      '「…」のウィンドウは再読み込みすると一覧が消えるため閉じました。もう一度「中を見る」を押してください',
    ]);
    expect(texts.join('')).not.toContain('人事');
  });

  it('呼び側が渡した fixedHead / fixedTail は表より優先する', () => {
    const w = wire();
    w.poster('案内「A」と「秘密」', { fixedHead: '案内「A」' });
    w.poster('「秘密」の後ろの案内「B」', { fixedTail: 'の後ろの案内「B」' });
    expect(w.post.recent().map((m) => m.text)).toEqual(['「…」の後ろの案内「B」', '案内「A」と「…」']);
  });
});

describe('#2084 ⑤ main.ts の配線(原文で pin)', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  it('OP_NOTICE の積み口は表を引く', () => {
    expect(main).toContain("appMessagePost.post({ kind: 'result', source: 'app', text: state.notice, ...fixedPartsOfAppText(state.notice) })");
  });
  it('OP_FAILED の積み口は固定の頭を優先し、表の終わりも渡す', () => {
    expect(main).toContain('const tableParts = fixedPartsOfAppText(errorText);');
    expect(main).toContain("fixedHead: fixedHeadOfOpError(state.error) || (tableParts.fixedHead ?? ''),");
    expect(main).toContain('...(tableParts.fixedTail !== undefined ? { fixedTail: tableParts.fixedTail } : {}),');
  });
});
