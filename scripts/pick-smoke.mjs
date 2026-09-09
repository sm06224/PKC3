#!/usr/bin/env node
/**
 * 🔴 **触った物から、走らせる smoke を引く**(#820。user 指摘 2026-09-09
 * 「最近、フルスモークが多すぎる / o(n2)のテストケース広がりを回避する方策を」)。
 *
 *   node scripts/pick-smoke.mjs                 # main との差分から引く(名前を出すだけ)
 *   node scripts/pick-smoke.mjs --run           # そのまま走らせる
 *   node scripts/pick-smoke.mjs src/a.ts …      # file を直に渡す
 *
 * ## 🔴 迷ったら**フル**へ倒す
 *
 * この道具が守るのは「**時間**」であって「正しさ」ではない。⚠ 外したときの害は
 * **確かめていない物を確かめたと言うこと**(CLAUDE.md「回さなすぎのほうが害が大きい」)
 * なので、**少しでも読めない物が混じったら全部走らせる**:
 *
 * | 触った物 | どうするか | なぜ |
 * |---|---|---|
 * | `tests/smoke/*.smoke.spec.ts` | **その spec** | 自分自身 |
 * | `tests/smoke/` のそれ以外(helpers / config / server) | 🔴 **フル** | 全 spec の土台 |
 * | `src/**` で表に在る | **動かした spec** | 記録がある |
 * | `src/**` で表に無い(新しい file) | 🔴 **フル** | どこから動くか分からない |
 * | `src` の中の `.css` | 🔴 **フル** | 見た目は被覆に**映らない** |
 * | `src` の外(build / scripts / docs / public / 設定) | 🔴 **フル** | `docs/manual.md` すら束に載る |
 * | 表そのものが無い・空 | 🔴 **フル** | 引く根拠が無い |
 *
 * ⚠ そして**着地の 1 回は、この道具を使わずフル**である(CLAUDE.md)── 表が言えるのは
 * 「**あの日の版で動かした**」であって「これから動かしうる」ではない。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

export const SPEC_DIR = 'tests/smoke/';
export const MAP_FILE = 'tests/smoke/smoke-map.json';

const full = (why) => ({ mode: 'full', specs: [], why });

/**
 * @param {readonly string[]} changed 触った file(repo からの相対 path)
 * @param {{src?: string[], specs?: Record<string, number[]>, always?: string[]} | null} map
 * @returns {{mode: 'full' | 'pick', specs: string[], why: string}}
 */
export function pickSmoke(changed, map) {
  if (map === null || map === undefined) return full('対応表が無い');
  const src = map.src ?? [];
  const specs = map.specs ?? {};
  if (src.length === 0 || Object.keys(specs).length === 0) return full('対応表が空');

  // src の名前 → その file を動かした spec(逆引きを 1 度だけ組む)
  const by = new Map();
  for (const [spec, ids] of Object.entries(specs)) {
    for (const i of ids) {
      const name = src[i];
      if (name === undefined) continue;
      const set = by.get(name) ?? new Set();
      set.add(spec);
      by.set(name, set);
    }
  }
  const known = new Set(src);

  // ⚠ 被覆を取れなかった spec は「何も動かしていない」ではなく「**分からない**」
  const picked = new Set(map.always ?? []);
  const untouched = [];
  for (const raw of changed) {
    const p = String(raw).trim().replace(/^\.\//, '');
    if (p === '') continue;
    if (p.startsWith(SPEC_DIR)) {
      /**
       * ⚠ **表そのものは飛ばす。** 作り直すと必ず差分に出るので、ここを土台と
       * 数えると **作り直した PR の間ずっとフル**になり、道具が死ぬ。
       * 🔑 表はこの script が読むだけで、アプリにも spec にも 1 バイトも効かない。
       */
      if (p === MAP_FILE) continue;
      if (p.endsWith('.smoke.spec.ts')) {
        picked.add(p.slice(SPEC_DIR.length));
        continue;
      }
      return full(`smoke の土台を触った(${p})`);
    }
    if (!p.startsWith('src/')) return full(`src の外を触った(${p})`);
    if (p.endsWith('.css')) return full(`見た目は被覆に映らない(${p})`);
    if (!known.has(p)) return full(`この版の束に無い ── 新しい file か(${p})`);
    const hit = by.get(p);
    if (hit === undefined) untouched.push(p);
    else for (const s of hit) picked.add(s);
  }

  const list = [...picked].sort().map((s) => SPEC_DIR + s);
  const why =
    untouched.length === 0
      ? `${list.length} 本を引いた`
      : `${list.length} 本を引いた(smoke が 1 度も動かしていない: ${untouched.join(', ')})`;
  return { mode: 'pick', specs: list, why };
}

/** `git diff --name-only` ── base との差分 + 手元の未 commit を合わせる。 */
function changedFromGit(base) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf-8' }).split('\n');
    } catch {
      return [];
    }
  };
  let from = base;
  if (from === undefined) {
    const mb = run(['merge-base', 'origin/main', 'HEAD'])[0]?.trim();
    from = mb !== undefined && mb !== '' ? mb : 'origin/main';
  }
  return [...run(['diff', '--name-only', from, '--']), ...run(['status', '--porcelain'])
    .map((l) => l.slice(3).trim())
    .filter((l) => l !== '')];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const run = argv.includes('--run');
  const bi = argv.indexOf('--base');
  const base = bi >= 0 ? argv[bi + 1] : undefined;
  const files = argv.filter((a, i) => !a.startsWith('--') && !(bi >= 0 && i === bi + 1));
  const map = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf-8')) : null;
  const changed = files.length > 0 ? files : changedFromGit(base);
  const r = pickSmoke(changed, map);
  process.stderr.write(`触った ${changed.length} 件 → ${r.mode === 'full' ? 'フル' : '選抜'}: ${r.why}\n`);
  /**
   * ⚠ **古い表は「引かなすぎ」の側へ効く**(表に在る file が、その後に新しい経路を
   * 得ても記録には無い)。落ちる訳ではないので**黙っていると誰も気づかない** ──
   * だから毎回、表がいつの物かを言う。作り直しは `npm run smoke:record && npm run smoke:map`。
   */
  const builtAt = map?.builtAt;
  if (typeof builtAt === 'string') {
    const days = Math.floor((Date.now() - Date.parse(builtAt)) / 86_400_000);
    if (days >= 14) {
      process.stderr.write(`⚠ 対応表は ${days} 日前の物 ── 作り直すなら npm run smoke:record && npm run smoke:map\n`);
    }
  }
  if (!run) {
    process.stdout.write(r.mode === 'full' ? 'FULL\n' : `${r.specs.join('\n')}\n`);
    process.exit(0);
  }
  if (r.mode === 'pick' && r.specs.length === 0) {
    process.stderr.write('走らせる spec が無い ── smoke が見ていない所だけを触った\n');
    process.exit(0);
  }
  const args = ['playwright', 'test', '--config', 'tests/smoke/playwright.config.ts', ...r.specs];
  const out = spawnSync('npx', args, { stdio: 'inherit' });
  process.exit(out.status ?? 1);
}
