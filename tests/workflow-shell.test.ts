/** @vitest-environment node */
/**
 * workflow の `run:` ブロックを **bash として検査する**(P7 段⑧)。
 *
 * 🔴 CI の shell は**走らせるまで誰も読まない**。このリポジトリは既に
 * `[ -f X ] && cmd || true` で事故っている(`&&` と `||` は同順位・左結合なので
 * `((A && B) || true)` になり、**「無いとき」ではなく「失敗したとき」も飛ばす**
 * ── 検品が `✗` を出した直後に deploy へ到達し、step は exit 0 だった)。
 * 注意書きは効かなかったので、機械で止める。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = '.github/workflows';

interface Block {
  file: string;
  code: string;
}

/** `run: |` のブロックを取り出す(インデントで本文を判定する)。 */
function runBlocks(): Block[] {
  const out: Block[] = [];
  for (const name of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(DIR, name), 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // ⚠ `- run: |`(リスト項目形)も拾う。当初は `run:` が行頭から
      // 空白だけの形しか見ておらず、**リスト項目形の block を丸ごと素通り**して
      // いた(変異試験で発覚 ── 構文エラーを入れても緑だった)
      const m = /^(\s*)(-\s+)?run: \|\s*$/.exec(lines[i]!);
      if (!m) continue;
      const indent = `${m[1]!}${' '.repeat((m[2] ?? '').length)}  `;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === '') {
          body.push('');
          continue;
        }
        if (!line.startsWith(indent)) break;
        body.push(line.slice(indent.length));
      }
      out.push({ file: name, code: body.join('\n') });
    }
  }
  return out;
}

describe('workflow の shell', () => {
  const blocks = runBlocks();

  it('🔴 `run:` ブロックが 1 つ以上ある(空振り防止)', () => {
    // ⚠ 抽出が壊れると「全部通った」という事実だけが残る
    expect(blocks.length).toBeGreaterThan(4);
  });

  it('🔴 すべての `run:` ブロックが bash として parse できる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-wf-'));
    const broken: string[] = [];
    try {
      blocks.forEach((b, i) => {
        const path = join(dir, `b${i}.sh`);
        // ⚠ `${{ … }}` は Actions が展開する前の記法 ── bash には読めないので
        // 無害な文字列へ置き換えてから構文だけを見る
        writeFileSync(path, b.code.replace(/\$\{\{[^}]*\}\}/g, 'X'));
        try {
          execFileSync('bash', ['-n', path], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
          const err = e as { stderr?: Buffer };
          broken.push(`${b.file}#${i}: ${String(err.stderr ?? '')}`);
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(broken).toEqual([]);
  });

  it('🔴 `A && B || C` を書かない(同順位・左結合で「失敗したとき」も飛ぶ)', () => {
    // 実証済みの事故: `[ -f X ] && node X || true` は検品の**失敗まで飛ばす**。
    // ⚠ 「無いときだけ飛ばしたい」なら `if …; then …; fi` と書く
    const offenders: string[] = [];
    for (const b of blocks) {
      for (const [n, line] of b.code.split('\n').entries()) {
        const code = line.replace(/#.*$/, ''); // コメントの中の説明文で誤検知しない
        if (/&&[^|]*\|\|/.test(code)) offenders.push(`${b.file}:${n + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
