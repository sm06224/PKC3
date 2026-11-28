/**
 * 🔴 **`src/features/dataflow/` は pure module**(#2115 PR-2)── DOM / window / Worker / adapter 層に触れない。
 *
 * ⚠ 注釈の中の字に当たって緑/赤にならないよう、注釈を剥がした実行行だけを見る(verification §1.3)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../../src/features/dataflow');
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

/** 注釈を剥がす(文字列の中の // は気にしない ── 当たれば赤に倒れる向き)。 */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('dataflow は pure', () => {
  it('file がある(空振りしない)', () => {
    expect(files).toEqual(
      expect.arrayContaining(['index.ts', 'note-datasets.ts', 'sql-views.ts', 'sql-refs.ts', 'dataflow-dag.ts', 'types.ts']),
    );
  });

  it.each(files)('%s は adapter / DOM / Worker / window を使わない', (f) => {
    const src = code(readFileSync(join(DIR, f), 'utf8'));
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(imports.length > 0 || f === 'names.ts' || f === 'types.ts').toBe(true);
    for (const i of imports) {
      expect(i, `${f}: ${i}`).toMatch(/^(@features\/|\.\/)/);
      expect(i).not.toMatch(/adapter|runtime|main/);
    }
    // ⚠ 語ではなく「使い方」で見る(SQL の WINDOW 句を読む正規表現に当たらないように)
    expect(src).not.toMatch(/\b(?:document|window|navigator|localStorage|indexedDB|globalThis)\s*[.[]/);
    expect(src).not.toMatch(/\bnew\s+(?:Worker|SharedWorker|MessageChannel)\b|\bpostMessage\s*\(|\bself\s*\./);
  });
});
