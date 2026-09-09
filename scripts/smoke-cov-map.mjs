/**
 * V8 の被覆 → **動かした `src` の一覧**(#820)。
 *
 * 🔴 **その場で畳む**。⚠ 生の被覆は 1 test で **4 MB**(実測)── 499 本ぶん置くと
 * **2 GB** になり、この箱のディスクの枠に収まらない。だから記録の側で
 * `src/**` へ引き戻し、**名前の一覧だけ**を残す(1 test 数 KB)。
 *
 * ⚠ sourcemap は**プロセスの中で使い回す**(86 file を test ごとに読み直さない)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from '@jridgewell/sourcemap-codec';

const cache = new Map();

function offsetToLine(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return [lo, off - starts[lo]];
  };
}

function chunkFor(url, distDir) {
  const name = String(url).split('/').pop();
  if (name === undefined || !name.endsWith('.js')) return null;
  if (cache.has(name)) return cache.get(name);
  const js = join(distDir, name);
  const map = `${js}.map`;
  let v = null;
  if (existsSync(js) && existsSync(map)) {
    const m = JSON.parse(readFileSync(map, 'utf-8'));
    v = {
      at: offsetToLine(readFileSync(js, 'utf-8')),
      lines: decode(m.mappings),
      sources: (m.sources ?? []).map((s) => String(s).replace(/^(\.\.\/)+/, '')),
    };
  }
  cache.set(name, v);
  return v;
}

function sourceAt(chunk, line, col) {
  const segs = chunk.lines[line];
  if (segs === undefined || segs.length === 0) return null;
  let best = null;
  for (const s of segs) {
    if (s[0] > col) break;
    if (s.length >= 4) best = s[1];
  }
  return best === null ? null : (chunk.sources[best] ?? null);
}

/**
 * @param {readonly unknown[]} entries `page.coverage.stopJSCoverage()` の返り
 * @param {string} distDir 生成物の置き場(既定 `dist/assets`)
 * @returns {string[]} 実際に**動いた** `src/**` の一覧(重複なし・並び固定)
 */
export function mapEntriesToSources(entries, distDir = 'dist/assets') {
  const out = new Set();
  for (const e of entries ?? []) {
    const chunk = chunkFor(e?.url ?? '', distDir);
    if (chunk === null) continue;
    for (const fn of e.functions ?? []) {
      for (const r of fn.ranges ?? []) {
        if ((r.count ?? 0) === 0) continue;
        const [line, col] = chunk.at(r.startOffset);
        const src = sourceAt(chunk, line, col);
        if (src !== null && src.startsWith('src/')) out.add(src);
      }
    }
  }
  return [...out].sort();
}
