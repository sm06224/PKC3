/**
 * 🔴 **メッセージ(バグ報告に貼る集積地)にノートの中身が載らない**(#1087)── 関数が返す文を実際に通す。
 *
 * `message-name-leak.test.ts` は字面の走査で、関数が返す文は見ない。ここは**返った文を `sanitizeMessageText` に通し**、
 * 元の字の一部が残らないことを見る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diagramExportErrorText } from '@features/error-text';
import { fixedHeadOfOpError, messageTextOfOpError } from '@features/message/caution-events';
import { markName, sanitizeMessageText } from '@features/message/message-log';

const main = readFileSync('src/main.ts', 'utf-8');

/** `state.error` → メッセージに積む字(main.ts の配線と同じ 2 関数を通す)。 */
const posted = (error: string): string => sanitizeMessageText(messageTextOfOpError(error), fixedHeadOfOpError(error));

describe('1. 図の書き出しの失敗', () => {
  const mermaidError =
    "Parse error on line 2:\n...A[契約書_極秘プロジェクト] --> B[役員報酬の見直し]\n-----------------------^\nExpecting 'SEMI', got 'NEWLINE'";
  it('画面の 1 行には原文が残り(手がかり)、メッセージには固定の先頭だけが積まれる', () => {
    const screen = diagramExportErrorText(new Error(mermaidError));
    expect(screen).toContain('極秘プロジェクト');
    const msg = posted(screen);
    expect(msg).toBe('図を書き出せませんでした');
    for (const frag of ['極秘', '役員報酬', 'Parse error', 'SEMI', 'A[']) expect(msg).not.toContain(frag);
  });
  it('原文が短くても漏れない(80 字の切りに頼らない)', () => {
    const msg = posted(diagramExportErrorText(new Error('給与テーブル')));
    expect(msg).not.toContain('給与');
  });
});

describe('2. 名前に 」 が入っている', () => {
  const titles = ['【重要】「A社との契約」について', 'a」b', '『社外秘』」の件', '「」'];
  it('markName で囲んだ名前は、中身に関係なく潰れる', () => {
    for (const t of titles) {
      const out = sanitizeMessageText(`添付の取り込みに失敗しました(「${markName(t)}」)`);
      expect(out).toBe('添付の取り込みに失敗しました(「…」)');
    }
  });
  it('🔴 目印の無い口でも、入れ子や余りの 」 を名前の中として潰す(260 か所を超える「${…}」の口の後半を残さない)', () => {
    expect(sanitizeMessageText('(「【重要】「A社との契約」について」)')).toBe('(「…」)');
    // 名前に 」 が 1 つだけ入った形(余りの閉じは直前の名前の続き)
    expect(sanitizeMessageText('「秘密」の続き」を開けませんでした')).toBe('「…」を開けませんでした');
    // 名前に 「 が 1 つだけ入って閉じずに終わる形は、末尾まで潰す
    expect(sanitizeMessageText('「秘密「の続き」を開けませんでした')).not.toContain('の続き');
    // 対照群:2 つの名前の間の字は残す
    expect(sanitizeMessageText('「A」から「B」へ移動しました')).toBe('「…」から「…」へ移動しました');
  });
  it('名前の中に目印の字が在っても、終わりが早まらない', () => {
    const out = sanitizeMessageText(`「${markName('前\u2061後ろ」の秘密')}」を開けませんでした`);
    expect(out).toBe('「…」を開けませんでした');
  });
  it('閉じる目印が欠けても、後ろまで潰す(漏らす側に倒れない)', () => {
    expect(sanitizeMessageText('「\u2060秘密の題名')).not.toContain('秘密');
  });
  it('主な口(添付の取り込み / 開く / ダウンロード / 起動タイルを開く)が markName を通している', () => {
    const attach = readFileSync('src/adapter/ui/actions/attach.ts', 'utf-8');
    const tile = readFileSync('src/adapter/ui/launch-tile.ts', 'utf-8');
    expect(attach).toContain('「${markName(item.name)}」');
    expect(tile).toContain('「${markName(tile.title)}」');
    for (const lead of ['添付の取り込みに失敗しました', '添付を開けませんでした', 'ダウンロードに失敗しました']) {
      expect(main).toContain(`${lead}(「\${markName(name)}」)`);
    }
  });
  it('目印は幅の無い字(画面の見た目を変えない)', () => {
    expect(markName('x').replace('x', '')).toMatch(/^[\u2060\u2061]{2}$/);
  });
});

describe('4. 起動の診断行', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const line = `起動しました:バージョン 3.5.0 / 保存先 opfs / フラグ 2 個 / ブラウザ ${ua} / 幅 1280px`;
  it('固定の文として積めば、ブラウザ名の後半と幅が残る(切らない側)', () => {
    expect(line.length).toBeGreaterThan(80);
    expect(sanitizeMessageText(line, line)).toContain('Safari/537.36 / 幅 1280px');
    // 対照群: 固定にしないと切れる
    expect(sanitizeMessageText(line)).not.toContain('幅 1280px');
  });
  it('main.ts が fixedHead 付きで積んでいる', () => {
    expect(main).toContain('text: bootLine,\n      fixedHead: bootLine,');
  });
});

describe('3. 画像に描き込む窓 ── main.ts の配線', () => {
  it('描きかけの間は unloadGuard の持ち主 image-draw として数える', () => {
    expect(main).toContain('onDirty: (dirty) => unloadGuard.setWriting(dirty, `image-draw:${args.windowName}`),');
  });
});
