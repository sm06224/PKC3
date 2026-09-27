/**
 * 🔴 **コード枠(```)の中身だけを差し替える純関数**(#1044 段3)。
 *
 * ⚠ 観測点は「開く」(`openCodeFenceAt`)と「探し直して差し替える」
 *   (`replaceCodeFenceContent` / `locateCodeFence`)── どちらも DOM も state も
 *   知らない純関数なので、原文だけで全数を当てる。
 */
import { describe, expect, it } from 'vitest';
import {
  openCodeFenceAt,
  replaceCodeFenceContent,
  locateCodeFence,
} from '../../src/features/markdown/code-fence-edit';

describe('openCodeFenceAt(#1044 段3)', () => {
  it('🔴 開きの行から、中身だけを控える(開き・閉じの行は含まない)', () => {
    const body = ['# note', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', '続き'].join(
      '\n',
    );
    const got = openCodeFenceAt(body, 2);
    expect(got, '開けなかった').not.toBeNull();
    expect(got!.line).toBe(2);
    expect(got!.openLine).toBe('```js');
    expect(got!.original).toBe('const a = 1;\nconst b = 2;');
    expect(got!.quote).toBe(0);
  });

  it('🔴 開きの行以外を押すと開かない(枠の中の任意の行では特定しない)', () => {
    const body = ['```js', 'const a = 1;', '```'].join('\n');
    expect(openCodeFenceAt(body, 1)).toBeNull();
    expect(openCodeFenceAt(body, 2)).toBeNull();
  });

  it('🔴 閉じていない枠(末尾まで続く)は開かない', () => {
    const body = ['```js', 'const a = 1;'].join('\n');
    expect(openCodeFenceAt(body, 0)).toBeNull();
  });

  it('🔴 その行が枠でなければ開かない', () => {
    const body = ['ただの段落です。'].join('\n');
    expect(openCodeFenceAt(body, 0)).toBeNull();
  });

  it('🔴 空の枠(開き・閉じが隣り合う)は原文が空文字', () => {
    const body = ['```js', '```'].join('\n');
    const got = openCodeFenceAt(body, 0);
    expect(got!.original).toBe('');
  });

  it('🔴 引用の中の枠は、前置きを剥がした中身を控える(#775 と同じ作法)', () => {
    const body = ['> ```js', '> const a = 1;', '> ```'].join('\n');
    const got = openCodeFenceAt(body, 0);
    expect(got, '引用の中の枠を開けなかった').not.toBeNull();
    expect(got!.openLine).toBe('```js');
    expect(got!.original).toBe('const a = 1;');
    expect(got!.quote).toBe(1);
  });

  it('🔴 `~~~` の柵でも開ける', () => {
    const body = ['~~~python', 'x = 1', '~~~'].join('\n');
    const got = openCodeFenceAt(body, 0);
    expect(got!.openLine).toBe('~~~python');
    expect(got!.original).toBe('x = 1');
  });

  it('🔴 負数・非整数の行は開かない(防波堤)', () => {
    const body = ['```js', 'x', '```'].join('\n');
    expect(openCodeFenceAt(body, -1)).toBeNull();
    expect(openCodeFenceAt(body, 1.5)).toBeNull();
  });
});

describe('replaceCodeFenceContent(#1044 段3、§9)', () => {
  const body = ['# note', '', '```js', 'const a = 1;', '```', '', '続き'].join('\n');

  it('🔴 行が同じなら、開いたときの身元と比べて差し替える', () => {
    const id = openCodeFenceAt(body, 2)!;
    const r = replaceCodeFenceContent(body, id, 'const a = 2;');
    expect(r.ok, '差し替えに失敗した').toBe(true);
    if (r.ok) {
      expect(r.body).toBe(['# note', '', '```js', 'const a = 2;', '```', '', '続き'].join('\n'));
    }
  });

  it('🔴 行がずれても、同じ柵・同じ中身の枠を探し直して差し替える', () => {
    const id = openCodeFenceAt(body, 2)!;
    // 別の窓が上に見出しを 1 つ足した(枠は 1 行下がる)
    const shifted = ['# note', '', '## もう1つの見出し', '', '```js', 'const a = 1;', '```', '', '続き'].join(
      '\n',
    );
    const r = replaceCodeFenceContent(shifted, id, 'const a = 2;');
    expect(r.ok, '探し直しに失敗した').toBe(true);
    if (r.ok) {
      expect(r.body).toBe(
        ['# note', '', '## もう1つの見出し', '', '```js', 'const a = 2;', '```', '', '続き'].join(
          '\n',
        ),
      );
    }
  });

  it('🔴 枠の中身が別の場所で書き換えられていたら、1 文字も書かずに断る(missing)', () => {
    const id = openCodeFenceAt(body, 2)!;
    const changed = ['# note', '', '```js', 'const a = 999;', '```', '', '続き'].join('\n');
    const r = replaceCodeFenceContent(changed, id, 'const a = 2;');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
  });

  it('🔴 同じ身元の枠が 2 個以上あれば、どれか決まらないので断る(ambiguous)', () => {
    const id = openCodeFenceAt(body, 2)!;
    // ⚠ 開いた行(2)には**もう枠が無い**形にする ── そうしないと「開いた行の枠」の
    //   直接一致が先に決まり、あいまいさを試せない(§9 の手順①が②より先に効く)。
    const twice = [
      '# note',
      '',
      '段落が増えて、開いた行はもう枠ではない',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '```js',
      'const a = 1;',
      '```',
    ].join('\n');
    const r = replaceCodeFenceContent(twice, id, 'const a = 2;');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('🔴 引用の中の枠は、前置きを付け直して差し戻す(#775 と同じ)', () => {
    const quoted = ['> ```js', '> const a = 1;', '> ```'].join('\n');
    const id = openCodeFenceAt(quoted, 0)!;
    const r = replaceCodeFenceContent(quoted, id, 'const a = 2;\nconst b = 3;');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toBe(['> ```js', '> const a = 2;', '> const b = 3;', '> ```'].join('\n'));
    }
  });

  it('🔴 引用の外へ移った(引用の深さが違う)枠は、身元が一致しない', () => {
    const id = openCodeFenceAt(body, 2)!; // quote: 0
    const quotedElsewhere = ['> ```js', '> const a = 1;', '> ```'].join('\n');
    const r = replaceCodeFenceContent(quotedElsewhere, id, 'const a = 2;');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing');
  });
});

describe('locateCodeFence(#1044 段3。replaceCodeFenceContent と同じ探し方)', () => {
  it('🔴 差し替えずに、いまどこに在るかだけ答える', () => {
    const body = ['```js', 'const a = 1;', '```'].join('\n');
    const id = openCodeFenceAt(body, 0)!;
    const shifted = ['', '```js', 'const a = 1;', '```'].join('\n');
    const r = locateCodeFence(shifted, id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fence.start).toBe(1);
  });
});
