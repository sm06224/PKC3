/** @vitest-environment node */
/**
 * 🔴 **cross-origin isolation のヘッダを、黙って外させない**(#88 O2 の前提 / #111)。
 *
 * ## この検査は 1 度、守っているつもりで守っていなかった
 *
 * 前身は `tests/features/coi-headers.test.ts` で、**`vite.config.ts` の原文**に
 * 2 行が在ることだけを見ていた。ところが `vite.config.ts` が配るのは
 * **dev と preview だけ**である ── 本番(GitHub Pages)はヘッダを返せないので、
 * この検査が全部緑でも**本番には 1 行も届いていなかった**(#111)。
 *
 * 🔑 題名は「分離のヘッダを外させない」なのに、守っていたのは
 * 「vite.config.ts に文字列が在る」だけだった。だから見る先を変える:
 *
 * | 配り先 | 誰が | 何が見るか |
 * |---|---|---|
 * | dev / preview | `vite.config.ts` | **この file**(共有定数を使っているか) |
 * | **本番** | service worker | `tests/adapter/sw-source.test.ts`(生成物を評価) |
 * | **本番・実ブラウザ** | 同上 | `tests/smoke/coi.smoke.spec.ts`(ヘッダ無し配信) |
 *
 * ⚠ **共有の定数から期待値を作らない。** `expect(H.x).toBe(H.x)` は何も守らない
 * ── 値を**書いて**比べる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COI_HEADERS, COI_HEADER_ENTRIES } from '../../src/adapter/platform/sw/coi-headers';

const CONFIG = readFileSync('vite.config.ts', 'utf-8');

describe('分離のヘッダ', () => {
  /**
   * 🔴 `require-corp` へ寄せると **CORP を返さない外部画像が全部消える**
   * (2026-08-10 実測)── 「外部画像の同意」機能がそのまま死ぬ。分離は成立するので
   * **Office は動いたまま**であり、user が気づくのは「いつのまにか画像が
   * 出なくなった」という形になる。だから値そのものを止める。
   */
  it('🔴 値は same-origin / credentialless(変えるのは仕様変更)', () => {
    expect(COI_HEADERS).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
  });

  it('🔴 片方だけでは分離しないので、2 つとも在る', () => {
    expect(COI_HEADER_ENTRIES).toHaveLength(2);
    expect(COI_HEADER_ENTRIES.map(([k]) => k).sort()).toEqual([
      'Cross-Origin-Embedder-Policy',
      'Cross-Origin-Opener-Policy',
    ]);
  });

  it('COOP / COEP を dev と preview の両方へ配っている', () => {
    // ⚠ 「それらしい語が在る」ではなく **配り先が 2 つある**ことを見る
    expect(CONFIG, 'dev server に付いている').toMatch(/server:\s*\{\s*headers:\s*COI_HEADERS\s*\}/);
    expect(CONFIG, 'preview にも付いている').toMatch(/preview:\s*\{\s*headers:\s*COI_HEADERS\s*\}/);
  });

  /**
   * ⚠ **綴りが 2 か所にあると片方だけ直る**(この repo は同じ形で 1 度壊した)。
   * ⚠ 原文 pin は弱いと自覚して使う ── 本番側は生成物を評価する test が見ている。
   */
  it('🔴 vite.config は値を書き写さず、共有の定数を import している', () => {
    expect(CONFIG).toContain('sw/coi-headers.ts');
    for (const [name, value] of COI_HEADER_ENTRIES) {
      expect(CONFIG, `${name} の値が vite.config に直書きされている`).not.toContain(`'${value}'`);
    }
  });

  it('🔴 require-corp を配っていない', () => {
    // ⚠ 説明の表には出てくるので、**コメント行を落としてから**見る
    const code = CONFIG.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('require-corp');
    expect(JSON.stringify(COI_HEADERS)).not.toContain('require-corp');
  });
});
