/**
 * reducer の原文(`app-state.ts` + `slices/*.ts`)を 1 本に繋いで返す(#1383)。
 *
 * 原文を読む検査(case の全数 pin・文言の一致・禁止語)は、case を領域ごとの slice へ移した後も
 * 「reducer 全体」を見張る必要がある。⚠ `app-state.ts` だけを読むと、移った case が検査から静かに外れる
 * (件数が 0 になる空振り)── 各検査は件数の下限で空振りを見張っているが、読む側をここに揃える。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/adapter/state';

/** slice の file 名(昇順)。⚠ 0 件なら分割が消えているか読む場所が違う ── 呼び側の検査が下限で落ちる。 */
export function reducerSliceFiles(): string[] {
  return readdirSync(join(DIR, 'slices'))
    .filter((n) => n.endsWith('.ts'))
    .sort()
    .map((n) => join(DIR, 'slices', n));
}

/** `app-state.ts` に slice を繋いだ原文。 */
export function readReducerSource(): string {
  return [join(DIR, 'app-state.ts'), ...reducerSliceFiles()].map((p) => readFileSync(p, 'utf-8')).join('\n');
}
