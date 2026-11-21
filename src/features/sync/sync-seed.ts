/**
 * 🔴 **端末間の同期(#2000)段 2 ── バックアップに添える「種の指紋」**(設計 doc §12.1 の約束 2)。
 *
 * 同じバックアップから復元した 2 台が、記録の無いまま最初の同期をすると、編集したノートが全部競合になる。
 * そこで、バックアップを**書き出す時点**の指紋の一覧(と書き出した端末の id)をファイル(`container.json` の `syncSeed`)に添え、
 * 取り込む側が**元の端末の前回の合意**として書く(`seedBaseline`)。復元後の編集は種に含まれない(書き出した時点の指紋だけ)。
 *
 * - 書くのは設定「端末間の同期」がオンのときの全体のバックアップだけ(オフのときは 1 バイトも変えない)。
 * - 取り込み側が種にするのは、**lid が変わらずに入ったノート**だけ(重なって振り直した物は、元の指紋と対応しない)。
 * - 読み手(旧いビルド)は知らないキーとして読み飛ばす。
 *
 * ⚠ pure module。
 */
import { seedBaseline, type Baseline } from './change-set';
import { isDeviceId } from './sync-state';
import type { DiffFingerprint } from './diff-file';
import { isMarkKey, markKeyLid } from './sync-marks';

export interface SyncSeed {
  /** 書き出した端末の id。 */
  device: string;
  /** 書き出した時点の全件の指紋(ノート + つながり)。 */
  fingerprints: DiffFingerprint[];
}

/** 読み込み(形が違う・id が壊れていれば `null` = 種なし。取り込み全体は失敗させない)。 */
export function parseSyncSeed(v: unknown): SyncSeed | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isDeviceId(o.device) || !Array.isArray(o.fingerprints)) return null;
  const out: DiffFingerprint[] = [];
  for (const x of o.fingerprints) {
    if (typeof x !== 'object' || x === null) return null;
    const r = x as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.c !== 'string' || r.c === '' || (r.p !== undefined && typeof r.p !== 'string')) return null;
    out.push(r.p === undefined ? { key: r.key, c: r.c } : { key: r.key, c: r.c, p: r.p });
  }
  return { device: o.device, fingerprints: out };
}

/**
 * 取り込んだバックアップの種から、記録にする指紋を作る。
 * `keptLids` = lid が変わらずに入ったノート。それ以外(振り直した物・入らなかった物)は種にしない。つながり(`rel:`)は両端が `keptLids` のときだけ。
 */
export function seedFromBackup(seed: SyncSeed, keptLids: ReadonlySet<string>): Baseline {
  const states = seed.fingerprints
    .filter((f) => {
      // 印(色ラベル・ピン留め)は、指すノートが種になるときだけ
      if (isMarkKey(f.key)) return keptLids.has(markKeyLid(f.key) ?? '');
      if (!f.key.startsWith('rel:')) return keptLids.has(f.key);
      const m = /^rel:(.*)\|(.*)\|[^|]*$/.exec(f.key);
      return m !== null && keptLids.has(m[1] as string) && keptLids.has(m[2] as string);
    })
    .map((f) => ({ key: f.key, content: f.c, ...(f.p === undefined ? {} : { place: f.p }) }));
  return seedBaseline(states);
}
