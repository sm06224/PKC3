/**
 * O4: 添付参照の**書き換え**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **構文で拾う** ── 散文に偶然現れた key を書き換えない(走査の規則を流用しない)
 *  ② 🔴 **後ろの境界を見る** ── 短い key が長い key の前半分に当たらない
 *  ③ 2 つの綴り(`asset:` / `…/asset/`)の両方に当たる
 *  ④ 何も当たらなければ**本文を触らない**(同一参照で返す)
 *  ⑤ 🔴 **走査との向きの違いを pin する** ── 走査は拾い、書き換えは触らない場所がある
 */
import { describe, expect, it } from 'vitest';
import { rewriteAssetRefs } from '../../src/features/asset/asset-ref-rewrite';
import { scanAssetRefsInto } from '../../src/features/asset/asset-ref-scan';

const OLD = 'ast-abc';
const NEW = 'ast-xyz';

const rewrite = (t: string) => rewriteAssetRefs(t, OLD, NEW);

describe('rewriteAssetRefs', () => {
  it('本文の asset: 参照を移す', () => {
    const r = rewrite(`![図](asset:${OLD})`);
    expect(r.text).toBe(`![図](asset:${NEW})`);
    expect(r.count).toBe(1);
  });

  it('携帯参照(pkc://…/asset/<key>)にも当たる', () => {
    const r = rewrite(`[資料](pkc://c1/asset/${OLD})`);
    expect(r.text).toBe(`[資料](pkc://c1/asset/${NEW})`);
    expect(r.count).toBe(1);
  });

  it('同じ本文に何度出ても全部移す', () => {
    const r = rewrite(`asset:${OLD} と asset:${OLD} と /asset/${OLD}`);
    expect(r.count).toBe(3);
    expect(r.text).not.toContain(OLD);
  });

  it('🔴 散文に偶然現れた key は書き換えない(走査の規則を流用しない)', () => {
    // ⚠ これが「狭く当てる」の中身 ── substring で置換していたらここが壊れる
    const text = `前の版の key は ${OLD} でした。`;
    const r = rewrite(text);
    expect(r.count, '構文になっていないので触らない').toBe(0);
    expect(r.text, '本文をそのまま返す').toBe(text);
  });

  it('🔴 短い key が長い key の前半分に当たらない(別の添付を壊さない)', () => {
    for (const tail of [
      'def',
      // 🔴 **ハイフンが本命**(変異試験で判明)。実際の key は `ast-<時刻>-<乱数>` なので、
      //    前半分が別の key と一致するときの区切りは**ほぼ必ず `-`** である。
      //    `def` だけを見ていたら、境界の字集合から `-` を落とす変異が生き延びた。
      '-xyz',
      '_2',
      '0',
    ]) {
      const text = `![別物](asset:${OLD}${tail})`;
      const r = rewrite(text);
      expect(r.count, `後ろが「${tail}」なので触らない`).toBe(0);
      expect(r.text).toBe(text);
    }
  });

  it('後ろが記号・行末なら当たる(境界の判定が厳しすぎない)', () => {
    expect(rewrite(`asset:${OLD})`).count, '閉じ括弧').toBe(1);
    expect(rewrite(`asset:${OLD}`).count, '行末').toBe(1);
    expect(rewrite(`asset:${OLD} `).count, '空白').toBe(1);
    expect(rewrite(`asset:${OLD}.`).count, '句点').toBe(1);
  });

  it('別の key は触らない', () => {
    const text = `asset:ast-other`;
    expect(rewrite(text)).toEqual({ text, count: 0 });
  });

  it('🔴 長い key の側から見ても取り違えない(前半分だけ一致しても当てない)', () => {
    // ⚠ 対称の反対側 ── 上は「短い key で長い参照を壊さない」、こちらは
    //    「長い key を短い参照に当てない」
    const text = `asset:${OLD}`;
    expect(rewriteAssetRefs(text, `${OLD}-more`, NEW).count).toBe(0);
  });

  it('同じ key への書き換えは何もしない(無駄な保存で版を積まない)', () => {
    const text = `asset:${OLD}`;
    expect(rewriteAssetRefs(text, OLD, OLD)).toEqual({ text, count: 0 });
  });

  it('空の key では何もしない', () => {
    const text = `asset:${OLD}`;
    expect(rewriteAssetRefs(text, '', NEW).count).toBe(0);
    expect(rewriteAssetRefs(text, OLD, '').count).toBe(0);
  });

  it('key に正規表現の特殊文字が入っても壊れない', () => {
    // ⚠ 実際の key は `ast-…` だが、取込で来た旧規則の key は何でもありうる
    const r = rewriteAssetRefs('asset:a.b+c', 'a.b+c', NEW);
    expect(r.count).toBe(1);
    expect(
      rewriteAssetRefs('asset:axbxc', 'a.b+c', NEW).count,
      '正規表現として解釈しない(. や + が任意の字に当たらない)',
    ).toBe(0);
  });
});

/**
 * 🔴 **走査と書き換えは、向きが違う**(CLAUDE.md の既存規律を test で固定する)。
 *
 * 走査は **keep 側**に誤差を出す(散文の key も「使われている」と読む)。
 * 書き換えは **触らない側**に誤差を出す(構文でないものは移さない)。
 * ⚠ この 2 つが**同じ答えを返してはいけない** ── 同じなら片方が誤った向きを
 * 持っていることになる。
 */
describe('走査との向きの違い', () => {
  it('🔴 散文の key は「使われている」と読まれ、しかし書き換えられない', () => {
    const text = `前の版の key は ${OLD} でした。`;
    const found: string[] = [];
    scanAssetRefsInto(text, new Set([OLD]), (k) => found.push(k));
    expect(found, '走査は拾う(消さないため)').toEqual([OLD]);
    expect(rewrite(text).count, '書き換えは触らない(誤爆しないため)').toBe(0);
  });

  it('🔴 書き換えが当たるものは、走査も必ず拾う(逆は成り立たない)', () => {
    // ⚠ この向きが崩れると、**書き換えた先の key を GC が消す**
    for (const text of [
      `![図](asset:${OLD})`,
      `[資料](pkc://c1/asset/${OLD})`,
      `asset:${OLD}`,
    ]) {
      expect(rewrite(text).count, `書き換えが当たる: ${text}`).toBeGreaterThan(0);
      const found: string[] = [];
      scanAssetRefsInto(text, new Set([OLD]), (k) => found.push(k));
      expect(found, `走査も拾う: ${text}`).toEqual([OLD]);
    }
  });
});
