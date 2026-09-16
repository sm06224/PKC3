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

/**
 * @param {string} why 読み手に出す理由(そのまま印字される)
 * @param {'no-map'|'empty-map'|'spec-scaffold'|'outside-src'|'css'|'unmapped-src'} reason
 *   🔑 **機械が読む側の理由**。⚠ `why` の字を `includes` で判定すると、
 *   文言を直した日に**黙って効かなくなる**(鳴らない検査が 1 つ増える)。
 */
const full = (why, reason) => ({ mode: 'full', specs: [], why, reason });

/**
 * 🔴 **いま `src` に在る file のうち、表が知らない割合**(#993)。
 *
 * ⚠ フルへ倒れる直接の原因は**日数ではなく、表に無い file を触ったかどうか**である
 * ── 表が 1 日古いだけでも、その日に足された file を触れば倒れる。
 * 🔑 だから古さは**割合**で言う(実測 2026-09-16: 7 日目で 474 件中 96 件 = 20.3%)。
 *
 * @param {readonly string[]} allSrc いま repo に在る `src/**` の file
 * @param {{src?: string[]} | null} map
 * @returns {{total: number, unmapped: number, ratio: number}}
 */
export function unmappedShare(allSrc, map) {
  const known = new Set(map?.src ?? []);
  const total = allSrc.length;
  const unmapped = allSrc.filter((f) => !known.has(f)).length;
  return { total, unmapped, ratio: total === 0 ? 0 : unmapped / total };
}

/** 🔑 これを超えたら、日数に関わらず言う(表がもう引けていない合図)。 */
export const UNMAPPED_WARN = 0.1;

/**
 * @param {readonly string[]} changed 触った file(repo からの相対 path)
 * @param {{src?: string[], specs?: Record<string, number[]>, always?: string[]} | null} map
 * @returns {{mode: 'full' | 'pick', specs: string[], why: string}}
 */
export function pickSmoke(changed, map) {
  if (map === null || map === undefined) return full('対応表が無い', 'no-map');
  const src = map.src ?? [];
  const specs = map.specs ?? {};
  if (src.length === 0 || Object.keys(specs).length === 0) return full('対応表が空', 'empty-map');

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
      return full(`smoke の土台を触った(${p})`, 'spec-scaffold');
    }
    if (!p.startsWith('src/')) return full(`src の外を触った(${p})`, 'outside-src');
    if (p.endsWith('.css')) return full(`見た目は被覆に映らない(${p})`, 'css');
    if (!known.has(p)) return full(`この版の束に無い ── 新しい file か(${p})`, 'unmapped-src');
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

/**
 * 🔴 **いま repo に在る `src/**` の `.ts`**(#993 の割合を出すため)。
 *
 * ⚠ `.css` / `.wasm` / 書体は数えない ── **表に載る余地が無い**(被覆は見た目を
 *   映さないし、生成物は束の source ではない)。数えると割合が水増しされ、
 *   「いつも赤い計器」になって誰も読まなくなる。
 * ⚠ git が居ない所では **空**を返す(= 割合 0。黙る側へ倒す ── 引く判断そのものは
 *   `pickSmoke` が持っているので、ここが黙っても**倒れ損なうことはない**)。
 * @returns {string[]}
 */
function srcFilesNow() {
  try {
    return execFileSync('git', ['ls-files', 'src'], { encoding: 'utf-8' })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.ts'));
  } catch {
    return [];
  }
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
  /**
   * 🔴 **鳴る条件を「日数」から「表に無い割合」へ移した**(#993。2026-09-16)。
   *
   * ⚠ 直す前は **14 日**より古いときだけ言っていた ── ところが表は 9/09 生まれで、
   *   **7 日目のこの日は 1 度も鳴っていない**のに、既に **471 件中 93 件(19.7%)**が
   *   表に無く、`src` を触るとほぼフルへ倒れていた。
   * 🔑 **日数は原因ではない** ── 倒れるのは「表に無い file を触ったとき」なので、
   *   言うべきは**どれだけ表から漏れているか**である(1 日古いだけでも、
   *   その日に足された file を触れば倒れる)。
   * ⚠ 日数の警告も**消さない** ── 割合が小さいまま中身だけ古くなる形
   *   (file は増えていないが、経路が増えた)は割合では見えない。
   */
  const share = unmappedShare(srcFilesNow(), map);
  const builtAt = map?.builtAt;
  const days =
    typeof builtAt === 'string'
      ? Math.floor((Date.now() - Date.parse(builtAt)) / 86_400_000)
      : null;
  const stale = share.ratio >= UNMAPPED_WARN || (days !== null && days >= 14);
  if (stale || r.reason === 'unmapped-src') {
    const pct = (share.ratio * 100).toFixed(1);
    const age = days === null ? '(いつの物か書いていない)' : `${days} 日前`;
    process.stderr.write(
      `⚠ 対応表は ${age} ── いま src の .ts ${share.total} 件のうち ${share.unmapped} 件(${pct}%)が表に無い\n` +
        '   作り直すなら npm run build && npm run smoke:record && npm run smoke:map\n',
    );
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
