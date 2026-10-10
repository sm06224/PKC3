/**
 * 🔴 タグの色の多重タブ同期の配線(#1457 レビュー)。
 *
 * `src/main.ts` はどの unit からも実行されない(原文 pin の妥協 ── 弱いと自覚して使う)。
 * 放送する側は `store-proxy.test.ts` が実物で見る。ここは**受け手の配線**を 2 つ pin する:
 * ①他タブの `changed`(`onRemoteChanged`)で色を読み直す ②保存に失敗したら**古い写しではなく storage を読み直す**。
 * 守っていないもの:実際に 2 タブ開いた画面(smoke にしていない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync('src/main.ts', 'utf-8');

/** 注釈を落として、実行する行だけにする。 */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function between(from: string, to: string): string {
  const a = main.indexOf(from);
  const b = main.indexOf(to, a);
  expect(a, `${from} が無い`).toBeGreaterThan(-1);
  expect(b, `${to} が無い`).toBeGreaterThan(a);
  return code(main.slice(a, b));
}

describe('タグの色の同期の配線', () => {
  it('🔴 他タブの変更で色を読み直す(onRemoteChanged の中)', () => {
    const body = between('const onRemoteChanged =', 'let unbindChanged');
    expect(body).toContain('reloadTagColors()');
    // 読み直しは storage の正本から
    const reload = between('const reloadTagColors', 'const onRemoteChanged');
    expect(reload).toContain("op: 'listTagColors'");
    expect(reload).toContain('applyTagColors(');
  });

  it('🔴 保存に失敗したら、古い写し(before)を戻さず storage を読み直す', () => {
    const set = between('setTagColor: (tag, color) =>', 'answerExternalImages: (allow)');
    expect(set).toContain("op: 'putTagColor'");
    const failure = set.slice(set.indexOf('.catch('));
    expect(failure).toContain('reloadTagColors()');
    expect(failure, '失敗で古い写しを戻している').not.toContain('before');
  });
});
