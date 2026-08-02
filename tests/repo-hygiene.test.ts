/**
 * リポジトリ衛生 ── **人の注意力に頼らない**ための機械的な歯止め。
 *
 * 🔴 「制御文字を正規表現に直書きしない」と注意書きしている当の file で、
 * 生バイトの DEL を 3 回埋めた(その都度 grep では見えず、書いた本人も
 * 気づかなかった)。注意書きは 3 回とも効かなかったので、test にする。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 追跡対象のテキスト file を集める(生成物・依存は見ない)。 */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|json|md|css|html|yml|yaml)$/.test(name)) out.push(full);
  }
  return out;
}

describe('リポジトリ衛生', () => {
  it('🔴 ソースに制御文字の生バイトが無い(タブ・改行を除く)', () => {
    const offenders: string[] = [];
    for (const f of [
      ...textFiles('src'),
      ...textFiles('tests'),
      ...textFiles('docs'),
      'CLAUDE.md',
      'README.md',
    ]) {
      let text: string;
      try {
        text = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // \n(0x0a) / \t(0x09) だけ許す。\r は CRLF fixture が持つので許す
        if ((c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) || c === 0x7f) {
          offenders.push(`${f}:${i} = U+${c.toString(16).padStart(4, '0')}`);
          break;
        }
      }
    }
    // ⚠ 期待は**空配列**。file 名まで出す(「どこか」では直せない)
    expect(offenders).toEqual([]);
  });
});
