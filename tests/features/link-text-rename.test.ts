/** @vitest-environment node */
/**
 * 改名のとき、ほかのノートのリンクの字を新しい題名へ書き換える規則(#1163 依頼 177、#1648)。
 *
 * 守る主張:
 * 1. 字が旧い題名と**同じ**リンクだけ書き換える(別の字・部分一致は残す)
 * 2. コードの中(囲み / 行内 / 字下げ)は書き換えない
 * 3. 書き換えるのはラベルの区間だけ ── 前後の byte(宛先の #章・題の引用・CRLF)は動かさない
 * 4. 別のノートを指すリンクは書き換えない(同じ字でも)
 * ⚠ 期待値は手で組んだ原文から作る(実装の規則を test 側で書き直さない)。
 */
import { describe, expect, it } from 'vitest';
import { renameLinkTexts } from '../../src/features/entry-ref/link-text-rename';

const run = (body: string, oldT = '旧い', newT = '新しい', lid = 'n1', cid: string | null = 'c1') =>
  renameLinkTexts(body, lid, cid, oldT, newT);

describe('renameLinkTexts', () => {
  it('旧い題名と同じ字のリンクだけ書き換える(別の字は残す)', () => {
    const body = '[旧い](entry:n1) と [自分で付けた字](entry:n1) と [旧い案内](entry:n1)\n';
    const r = run(body);
    expect(r.count).toBe(1);
    expect(r.body).toBe('[新しい](entry:n1) と [自分で付けた字](entry:n1) と [旧い案内](entry:n1)\n');
  });

  it('同じ字でも別のノートを指すリンクは書き換えない(対照群: n1 は書き換わる)', () => {
    const body = '[旧い](entry:n2)\n[旧い](entry:n1)\n[旧い](entry:n12)\n';
    const r = run(body);
    expect(r.count).toBe(1);
    expect(r.body).toBe('[旧い](entry:n2)\n[新しい](entry:n1)\n[旧い](entry:n12)\n');
  });

  it('宛先の #章 ・題の引用・同じ入れ物の pkc:// 形も、ラベルだけ書き換える', () => {
    const body = '[旧い](entry:n1#章) [旧い](entry:n1 "題") [旧い](pkc://c1/entry/n1) [旧い](pkc://zz/entry/n1)\n';
    const r = run(body);
    expect(r.count).toBe(3);
    expect(r.body).toBe(
      '[新しい](entry:n1#章) [新しい](entry:n1 "題") [新しい](pkc://c1/entry/n1) [旧い](pkc://zz/entry/n1)\n',
    );
  });

  it('コードの中は書き換えない(囲み・行内コード・字下げ)。外の 1 件は書き換える', () => {
    const body = [
      '```',
      '[旧い](entry:n1)',
      '```',
      '`[旧い](entry:n1)`',
      '',
      '    [旧い](entry:n1)',
      '',
      '[旧い](entry:n1)',
      '',
    ].join('\n');
    const r = run(body);
    expect(r.count).toBe(1);
    expect(r.body).toBe(body.replace(/\n\[旧い\]\(entry:n1\)\n$/, '\n[新しい](entry:n1)\n'));
  });

  it('画像の形 ![旧い](entry:n1) は書き換えない', () => {
    const body = '![旧い](entry:n1)\n';
    expect(run(body)).toEqual({ body, count: 0 });
  });

  it('題名に記法の字があっても、画面が書く綴り(escape 済み)と同じなら書き換え、新しい字も escape して書く', () => {
    const body = '[a\\*b](entry:n1)\n';
    const r = run(body, 'a*b', '新[題]');
    expect(r.count).toBe(1);
    expect(r.body).toBe('[新\\[題\\]](entry:n1)\n');
  });

  it('CRLF の本文は改行コードを保つ', () => {
    const body = '前\r\n[旧い](entry:n1)\r\n後\r\n';
    expect(run(body).body).toBe('前\r\n[新しい](entry:n1)\r\n後\r\n');
  });

  it('一致が無ければ入力をそのまま返す(0 件)', () => {
    const body = '[別の字](entry:n1)\n';
    const r = run(body);
    expect(r.count).toBe(0);
    expect(r.body).toBe(body);
  });
});
