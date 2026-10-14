/**
 * 🔴 **線で繋いだ付箋を消した後に新しい付箋を繋いでも、空いた名前を使い回さない**(#1087)。
 * 🔴 **閉じていない付箋は、消す書換が断る ── その条件を画面の側も同じ関数で見る**。
 *
 * ## user の物語(名前)
 * 付箋 A と B を線で繋ぐ(A は `板1`、B は `板2` と名付けられ、線は `from=板1 to=板2`)。A を消す。
 * **線の行は本文に残る**(`from=板1` のまま)。次に新しい付箋 C を B に繋ぐと、空いた `板1` が C に
 * 付いて、**古い線が勝手に C へ繋がった**(見えない所で配線が変わる)。
 *
 * 観測点は `applyBodyRewrite`(書く当の関数)の戻りの本文。対照群は「線が残っていない本文なら `板1` を使う」
 * (= 名前の採り方そのものは変わっていない)。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { placeBlockUnclosed } from '../../src/features/markdown/place-notation';

const A = [':::format{.pkc-place x=0 y=0 w=100 h=60}', 'A', ':::', ''];
const B = [':::format{.pkc-place x=300 y=0 w=100 h=60}', 'B', ':::', ''];
const C = [':::format{.pkc-place x=600 y=0 w=100 h=60}', 'C', ':::', ''];

const lines = (body: string): string[] => body.split('\n');
const connect = (body: string, from: number, to: number): string | null =>
  applyBodyRewrite(body, {
    kind: 'place-connect',
    from: { line: from, openLine: lines(body)[from]! },
    to: { line: to, openLine: lines(body)[to]! },
    fromAnchor: null,
    toAnchor: null,
  });

describe('線が指している名前も「使用中」に数える', () => {
  // A→B を繋いだ本文
  const joined = connect([...A, ...B].join('\n'), 0, 4)!;
  // A を消した本文(線の行は残る)
  const removed = applyBodyRewrite(joined, { kind: 'place-remove', line: 0, openLine: lines(joined)[0]! })!;

  it('前提:A→B を繋ぐと A=板1・B=板2・線 from=板1 to=板2。A を消しても線の行は残る', () => {
    expect(lines(joined)[0]).toContain('#板1');
    expect(lines(joined)[4]).toContain('#板2');
    expect(joined).toContain('from=板1 to=板2');
    expect(removed, '前提:A の塊が消えていない').not.toContain('\nA\n');
    expect(removed, '前提:線の行が消えた').toContain('from=板1 to=板2');
  });

  it('🔴 新しい付箋 C を B に繋いでも、C に `板1` を付けない(古い線が C へ繋がらない)', () => {
    const body = `${removed}${C.join('\n')}`;
    const at = lines(body);
    const cLine = at.findIndex((l) => l.includes('x=600'));
    const bLine = at.findIndex((l) => l.includes('#板2'));
    expect(cLine, '前提:C が見つからない').toBeGreaterThan(-1);
    const out = connect(body, cLine, bLine)!;
    expect(out).not.toBeNull();
    const cOpen = lines(out).find((l) => l.includes('x=600'))!;
    expect(cOpen, '空いた名前を使い回した').not.toContain('#板1');
    expect(cOpen).toContain('#板3');
    // 古い線は 1 byte も変わらず、C を指さない
    expect(out).toContain(':::format{.pkc-line from=板1 to=板2}');
  });

  it('対照群:線が残っていない本文なら、空いた `板1` を使う(名前の採り方は変えていない)', () => {
    // A を消すだけでなく、線の塊も消した本文
    const bare = [...B].join('\n').replace(':::format{.pkc-place', ':::format{#板2 .pkc-place') + '\n' + C.join('\n');
    const at = lines(bare);
    const cLine = at.findIndex((l) => l.includes('x=600'));
    const bLine = at.findIndex((l) => l.includes('#板2'));
    const out = connect(bare, cLine, bLine)!;
    expect(lines(out).find((l) => l.includes('x=600'))).toContain('#板1');
  });

  it('接続点つきの線(`from=板1:right`)が指す名前も数える', () => {
    const body = [
      ':::format{#板2 .pkc-place x=300 y=0 w=100 h=60}',
      'B',
      ':::',
      '',
      ...C,
      ':::format{.pkc-line from=板1:right to=板2:left}',
      ':::',
      '',
    ].join('\n');
    const at = lines(body);
    const cLine = at.findIndex((l) => l.includes('x=600'));
    const out = connect(body, cLine, 0)!;
    expect(lines(out).find((l) => l.includes('x=600'))).not.toContain('#板1');
  });
});

describe('placeBlockUnclosed ── 消す書換が断る条件と同じ関数', () => {
  const closed = ':::format{.pkc-place x=0 y=0 w=100 h=60}\nA\n:::\n';
  const unclosed = ':::format{.pkc-place x=0 y=0 w=100 h=60}\nA\n';

  it('🔴 閉じていなければ真・閉じていれば偽。書込側(place-remove)が断る形と一致する', () => {
    expect(placeBlockUnclosed(unclosed, 0)).toBe(true);
    expect(placeBlockUnclosed(closed, 0)).toBe(false);
    const rm = (b: string) => applyBodyRewrite(b, { kind: 'place-remove', line: 0, openLine: lines(b)[0]! });
    expect(rm(unclosed), '閉じていない付箋を消した').toBeNull();
    expect(rm(closed)).not.toBeNull();
  });

  it('frontmatter の下でも、生の行番号で見る', () => {
    const fm = `---\ntags: [x]\n---\n${unclosed}`;
    expect(placeBlockUnclosed(fm, 3)).toBe(true);
    expect(placeBlockUnclosed(`---\ntags: [x]\n---\n${closed}`, 3)).toBe(false);
    expect(placeBlockUnclosed(fm, 1), 'frontmatter の中は閉じていない塊ではない').toBe(false);
  });
});
