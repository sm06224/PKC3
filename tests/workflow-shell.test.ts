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

  it('🔴 `pipefail` の下で外部コマンドを `grep -q` へ流さない(SIGPIPE で偽陰性)', () => {
    // 🔴 2026-08-10 に実測で踏んだ。`nm big.a | grep -q SYM` は、grep が最初の一致で
    // 打ち切るため **nm が SIGPIPE で死に、`pipefail` がそれを拾って pipeline が失敗する**。
    // つまり **記号が在るときほど失敗する** ── 実測で「在る記号」に対し exit=74
    // (pipefail 無しなら 0)。`if ! … | grep -q …` は**常に「無い」側**へ分岐していた。
    //
    // ⚠ `printf` / `echo` は shell 組込みで出力も小さく、pipe バッファに収まって
    // 書き終えるので該当しない。**危ないのは「大きな出力を出す外部コマンド」**である。
    // 🔑 直し方: 一度ファイルへ落としてから `grep -q file` と書く。
    const offenders: string[] = [];
    for (const b of blocks) {
      const logical = b.code
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .replace(/\\\n/g, ' ');
      if (!/set\s+-[a-z]*o?\s*.*pipefail|set\s+-o\s+pipefail/.test(logical)) continue;
      for (const [n, line] of logical.split('\n').entries()) {
        // 判定に使う grep(-q / -m)だけを見る。表示用の `| head` は対象外
        const m = /^(.*?)\|\s*grep\s+(?:-\w*\s+)*-\w*[qm]/.exec(line);
        if (!m) continue;
        const producer = m[1]!.trim().replace(/^.*?[;&|(]\s*/, '');
        if (/^(printf|echo)\b/.test(producer)) continue;
        offenders.push(`${b.file}:~${n + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('🔴 `A && B || C` を書かない(同順位・左結合で「失敗したとき」も飛ぶ)', () => {
    // 実証済みの事故: `[ -f X ] && node X || true` は検品の**失敗まで飛ばす**。
    // ⚠ 「無いときだけ飛ばしたい」なら `if …; then …; fi` と書く
    // ⚠ **論理行で見る**(round-3 review L-2)。行単位だと `\\` の行継続で
    // またいだ形が素通りする ── 守ろうとしている当の `pages.yml` が継続を使うので、
    // 同じ file の中に抜け道が開いていた(実証: 継続を使った `&& … || true` が全緑)
    const offenders: string[] = [];
    for (const b of blocks) {
      // コメント行を落としてから継続を畳む(説明文の中の記号で誤検知しない)
      const logical = b.code
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .replace(/\\\n/g, ' ');
      for (const [n, line] of logical.split('\n').entries()) {
        if (/&&[^|]*\|\|/.test(line)) offenders.push(`${b.file}:~${n + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
