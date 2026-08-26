/**
 * 🔴 **整理案(プラン)の読み手**(#429 段②)。
 *
 * ⚠ ここでいちばん大事なのは、**段① が AI に教えた書き方と、この読み手が
 *   受ける書き方が同じであること** ── ずれると AI は言われたとおりに書いたのに
 *   断られ、user には**どちらが間違っているのか分からない**。
 */
import { describe, it, expect } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  PLAN_MAX_OPS,
  canApplyPlan,
  parsePlan,
  planPreview,
} from '../../src/features/structure/structure-plan';
import { STRUCTURE_HELP } from '../../src/features/structure/structure-text';

const meta = (lid: string, archetype = 'text'): EntryMeta =>
  ({ lid, title: 't-' + lid, archetype, entryOrder: 0, archived: false }) as EntryMeta;

const world = (...lids: string[]) => new Map(lids.map((l) => [l, meta(l)]));
const W = world('a', 'b', 'c', 'box');

const ok = (text: string) => {
  const p = parsePlan(text, W);
  expect(p.errors, `誤りが出た: ${JSON.stringify(p.errors)}`).toEqual([]);
  return p.ops;
};

describe('読める形', () => {
  it('mv ── フォルダの lid へ移す', () => {
    expect(ok('mv a box')).toEqual([{ kind: 'mv', lid: 'a', parent: { at: 'lid', lid: 'box' } }]);
  });

  it('mv ── root へ戻す', () => {
    expect(ok('mv a root')).toEqual([{ kind: 'mv', lid: 'a', parent: { at: 'root' } }]);
  });

  it('mkdir ── 親を省くと root(`STRUCTURE_HELP` の字のとおり)', () => {
    expect(ok('mkdir "資料"')).toEqual([
      { kind: 'mkdir', title: '資料', parent: { at: 'root' }, alias: null },
    ]);
  });

  it('mkdir ── 親を指定できる', () => {
    expect(ok('mkdir "2026" box')[0]).toMatchObject({ parent: { at: 'lid', lid: 'box' } });
  });

  it('rename ── 題名を変える', () => {
    expect(ok('rename a "新しい題名"')).toEqual([
      { kind: 'rename', lid: 'a', title: '新しい題名' },
    ]);
  });

  it('🔴 題名に空白が入っていても 1 つとして読む', () => {
    expect(ok('mkdir "議事録 2026 年"')[0]).toMatchObject({ title: '議事録 2026 年' });
    expect(ok('rename a "会議 メモ"')[0]).toMatchObject({ title: '会議 メモ' });
  });

  it('# の行と空行は読み飛ばす', () => {
    expect(ok('# これは説明\n\nmv a box\n\n# おわり')).toHaveLength(1);
  });

  it('前後の空白は気にしない', () => {
    expect(ok('   mv a box   ')).toHaveLength(1);
  });
});

/**
 * 🔴 **`as @名前` の前方参照**(#429 の本命)。
 * 「新しいフォルダを作って、そこへまとめて移す」が 1 つの案で書ける。
 */
describe('as @名前', () => {
  it('🔴 作った名前を、後の行が親として指せる', () => {
    const ops = ok('mkdir "アーカイブ" as @arc\nmv a @arc\nmv b @arc');
    expect(ops[0]).toMatchObject({ kind: 'mkdir', alias: 'arc' });
    expect(ops[1]).toMatchObject({ kind: 'mv', parent: { at: 'alias', alias: 'arc' } });
    expect(ops[2]).toMatchObject({ kind: 'mv', parent: { at: 'alias', alias: 'arc' } });
  });

  it('名前つきフォルダの中に、さらに名前つきフォルダを作れる', () => {
    const ops = ok('mkdir "上" as @up\nmkdir "下" @up as @dn\nmv a @dn');
    expect(ops[1]).toMatchObject({ parent: { at: 'alias', alias: 'up' }, alias: 'dn' });
    expect(ops[2]).toMatchObject({ parent: { at: 'alias', alias: 'dn' } });
  });

  it('🔴 **前の行で作られていない名前**は誤り(適用の順番が決まらない)', () => {
    const p = parsePlan('mv a @arc\nmkdir "アーカイブ" as @arc', W);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.line, '行番号が違う').toBe(1);
    expect(p.errors[0]!.message).toContain('この行より前で作られていません');
  });

  it('🔴 同じ名前を 2 回は使えない(どちらを指すか決まらない)', () => {
    const p = parsePlan('mkdir "A" as @x\nmkdir "B" as @x', W);
    expect(p.errors[0]!.line).toBe(2);
    expect(p.errors[0]!.message).toContain('既に使われています');
  });

  it('as の後が @名前 でなければ誤り', () => {
    expect(parsePlan('mkdir "A" as arc', W).errors[0]!.message).toContain('as の後は @名前');
    expect(parsePlan('mkdir "A" as @', W).errors[0]!.message).toContain('as の後は @名前');
  });
});

describe('誤りの返し方', () => {
  it('🔴 **1 件目で止めない**(直しては貼り直す、を繰り返させない)', () => {
    const p = parsePlan('mv zzz box\nrename yyy "x"\nnope a b', W);
    expect(p.errors, '途中で止まっている').toHaveLength(3);
    expect(p.errors.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it('🔴 行番号は **1 始まり**(user が見る番号)', () => {
    expect(parsePlan('mv zzz box', W).errors[0]!.line).toBe(1);
  });

  it('# の行を数に入れて行番号がずれない', () => {
    const p = parsePlan('# 説明\n# 説明\nmv zzz box', W);
    expect(p.errors[0]!.line, 'コメントを飛ばして数えている').toBe(3);
  });

  it('存在しない lid は誤り(適用の途中で初めて落とさない)', () => {
    expect(parsePlan('mv zzz box', W).errors[0]!.message).toContain('というノートはありません');
    expect(parsePlan('mv a zzz', W).errors[0]!.message).toContain('というノートはありません');
  });

  it('🔴 知らない命令は**黙って飛ばさない**', () => {
    /**
     * ⚠ 飛ばすと、AI が綴りを間違えた行が消えて「一部だけ適用された」に見える
     *   ── 何が起きなかったのか画面のどこにも出ない。
     */
    const p = parsePlan('delete a', W);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.message).toContain('知らない命令');
    expect(p.ops, '知らない命令なのに何か積んだ').toEqual([]);
  });

  it('題名の囲みが無い / 閉じていない', () => {
    expect(parsePlan('mkdir 資料', W).errors[0]!.message).toContain('" " で囲んで');
    expect(parsePlan('mkdir "資料', W).errors[0]!.message).toContain('" " で囲んで');
    expect(parsePlan('rename a 新題名', W).errors[0]!.message).toContain('" " で囲んで');
  });

  it('空の題名は誤り(押す所の無いフォルダを作らない)', () => {
    expect(parsePlan('mkdir "  "', W).errors[0]!.message).toContain('題名が空');
    expect(parsePlan('rename a ""', W).errors[0]!.message).toContain('題名が空');
  });

  it('🔴 自分自身の中へは移せない(適用してから気づかせない)', () => {
    expect(parsePlan('mv a a', W).errors[0]!.message).toContain('自分自身');
  });

  it('mv / rename に lid が無い', () => {
    expect(parsePlan('mv', W).errors[0]!.message).toContain('mv <lid>');
    expect(parsePlan('rename', W).errors[0]!.message).toContain('rename <lid>');
  });

  it('🔴 誤った行は ops に積まない(半分だけ適用させない)', () => {
    const p = parsePlan('mv a box\nmv zzz box\nmv b box', W);
    expect(p.ops, '誤りの行まで積んでいる').toHaveLength(2);
    expect(p.errors).toHaveLength(1);
  });
});

describe('上限', () => {
  it(`🔴 ${PLAN_MAX_OPS} 行を超えたら断る(貼り間違いを一括適用しない)`, () => {
    const many = Array.from({ length: PLAN_MAX_OPS + 20 }, () => 'mv a box').join('\n');
    const p = parsePlan(many, W);
    expect(p.ops).toHaveLength(PLAN_MAX_OPS);
    expect(p.errors.length, '断っていない').toBeGreaterThan(0);
    expect(p.errors[0]!.message).toContain(`${PLAN_MAX_OPS}`);
  });

  it('⚠ 断りは 1 つだけ(500 行ぶん並べない)', () => {
    const many = Array.from({ length: PLAN_MAX_OPS + 20 }, () => 'mv a box').join('\n');
    expect(parsePlan(many, W).errors).toHaveLength(1);
  });
});

/**
 * 🔴 **書き出す側(段①)と読む側(段②)が同じ書き方である**(CLAUDE.md §7)。
 *
 * ⚠ ずれると、AI は `STRUCTURE_HELP` のとおりに書いたのに断られる ──
 *   そして user には**どちらが間違っているのか分からない**。
 */
describe('段① の説明どおりに書いたら読める', () => {
  it('空振り防止 ── 説明に命令の綴りが載っている', () => {
    const help = STRUCTURE_HELP.join('\n');
    for (const cmd of ['mv', 'mkdir', 'rename', 'as @', 'root']) {
      expect(help, `説明に ${cmd} が無い`).toContain(cmd);
    }
  });

  it('🔴 説明に書いてある 3 つの形が、そのまま読める', () => {
    /**
     * ⚠ 説明の字(`mv <lid> <フォルダのlid|@名前|root>`)を、実在の lid に
     *   置き換えただけの行を通す ── 通らなければ**説明が嘘**である。
     */
    expect(ok('mv a box')).toHaveLength(1);
    expect(ok('mkdir "題名" box as @n')).toHaveLength(1);
    expect(ok('rename a "新しい題名"')).toHaveLength(1);
  });

  it('🔴 説明が謳う「作って、そこへまとめて移す」が 1 つの案で書ける', () => {
    const help = STRUCTURE_HELP.join('\n');
    expect(help, '前提が崩れている ── 説明がその用途を謳っていない').toContain('まとめて移す');
    expect(ok('mkdir "新しい箱" as @n\nmv a @n\nmv b @n\nmv c @n')).toHaveLength(4);
  });

  it('🔴 説明の「# で始まる行と空行は読み飛ばします」が本当である', () => {
    const help = STRUCTURE_HELP.join('\n');
    expect(help).toContain('# で始まる行と空行は読み飛ばします');
    expect(parsePlan(STRUCTURE_HELP.join('\n'), W), '説明そのものを貼ると誤りが出る').toEqual({
      ops: [],
      errors: [],
    });
  });
});

/**
 * 🔴 **適用したら何が起きるか(下見)**(#429 段③)。
 * ⚠ user が読むのは**題名**である ── lid を並べても何も分からない。
 */
describe('下見', () => {
  const named = new Map<string, EntryMeta>([
    ['a', { ...meta('a'), title: '議事録' } as EntryMeta],
    ['box', { ...meta('box', 'folder'), title: '資料' } as EntryMeta],
  ]);
  const lines = (text: string) => planPreview(parsePlan(text, named).ops, named).map((l) => l.text);

  it('🔴 lid ではなく**題名**で書く', () => {
    const [t] = lines('mv a box');
    expect(t).toContain('議事録');
    expect(t).toContain('資料');
    expect(t, 'lid が user に見えている').not.toContain('a');
  });

  it('root は「いちばん上」と書く(内部語を出さない)', () => {
    expect(lines('mv a root')[0]).toContain('いちばん上');
    expect(lines('mv a root')[0], 'root という内部語が出ている').not.toContain('root');
  });

  it('🔴 `@名前` は、その行で作る**題名**に読み替える', () => {
    /**
     * ⚠ 読み替えないと「@arc の中へ移します」という、user には意味の無い字になる
     *   ── 案の中で作るフォルダはまだ lid を持たない。
     */
    const t = lines('mkdir "アーカイブ" as @arc\nmv a @arc');
    expect(t[1]).toContain('アーカイブ');
    expect(t[1], '内部の別名がそのまま出ている').not.toContain('@arc');
  });

  it('作る / 移す / 変える が、それぞれ読める字になる', () => {
    expect(lines('mkdir "新箱"')[0]).toContain('作ります');
    expect(lines('mv a box')[0]).toContain('移します');
    expect(lines('rename a "新題名"')[0]).toContain('変えます');
  });

  it('印(kind)も返す ── 画面が字から読み取らなくて済む', () => {
    const p = planPreview(parsePlan('mkdir "x"\nmv a box\nrename a "y"', named).ops, named);
    expect(p.map((l) => l.kind)).toEqual(['mkdir', 'mv', 'rename']);
  });

  it('行の数は命令の数と同じ(黙って畳まない)', () => {
    expect(lines('mv a box\nmv a root\nrename a "z"')).toHaveLength(3);
  });
});

describe('適用してよいか', () => {
  it('🔴 誤りが 1 行でもあれば押せない(半分だけ適用させない)', () => {
    expect(canApplyPlan(parsePlan('mv a box\nmv zzz box', W))).toBe(false);
  });

  it('🔴 何も無い案は押せない(押しても何も起きないボタンを出さない)', () => {
    expect(canApplyPlan(parsePlan('', W))).toBe(false);
    expect(canApplyPlan(parsePlan('# 説明だけ', W))).toBe(false);
  });

  it('誤りが無くて中身があれば押せる', () => {
    expect(canApplyPlan(parsePlan('mv a box', W))).toBe(true);
  });
});
