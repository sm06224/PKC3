/**
 * #1087: 本文だけを書き換える書込は `keepMeta: true` を渡す(別のタブの改名・並べ替えを巻き戻さない)。
 *
 * 守るもの: `store-effects.ts` の `store.persistEntry(...)` を**全数**走査し、`keepMeta` を渡さない書込が
 * 「題名・種類・並びを変えるのが目的の 2 つ(版へ戻す / ゴミ箱から戻す)」だけであること。
 * ⚠ 守らないもの: 各呼び出しの挙動(まとめてタグの挙動は `bulk-tag-wiring.test.ts`、worker 側の意味論は
 *   `storage-worker.test.ts`)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/adapter/state/store-effects.ts', 'utf-8');
/** 注釈を落とす(説明文の `keepMeta` に満たされない)。 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^\s*\/\/.*$/gm, '');

function calls(): string[] {
  const out: string[] = [];
  let i = code.indexOf('store.persistEntry(');
  while (i >= 0) {
    let depth = 0;
    let j = code.indexOf('(', i);
    const start = j;
    for (; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')' && --depth === 0) break;
    }
    out.push(code.slice(start, j + 1));
    i = code.indexOf('store.persistEntry(', j);
  }
  return out;
}

describe('#1087 persistEntry の keepMeta', () => {
  it('🔴 keepMeta を渡さない書込は、版へ戻す・ゴミ箱から戻す(題名・種類を変えるのが目的)の 2 つだけ', () => {
    const all = calls();
    expect(all.length, '走査が空振り(呼び出しが見つからない)').toBeGreaterThanOrEqual(14);
    const without = all.filter((c) => !/keepMeta/.test(c));
    expect(without.length, '新しい書込が keepMeta を渡していない(本文だけの書込なら付ける)').toBe(2);
    // 目印は「渡している本文が版の本文」であること ── 件数の等値だけにしない
    for (const c of without) expect(c, '版・ゴミ箱の復元以外が keepMeta を落とした').toContain('body: rev.body');
  });
});
