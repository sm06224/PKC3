#!/usr/bin/env node
/**
 * PKC3: commit を守る hook を **作業ツリーの外**(`.git/hooks/`)へ入れる。
 *
 * 🔴 **2026-09-12: 1 稿目はこれを `git config core.hooksPath .githooks` で済ませ、
 * そのやり方は動かなかった。** hooksPath は**作業ツリーの中**を指すので、
 * `git checkout main` すると `.githooks/pre-commit` ごと消え、
 * 🔴 **守るはずの場所でだけ hook が居なくなる**(git は「無い」を黙って通す)。
 * ⚠ しかも当時の test は hook を `sh` で直に走らせていたので、**緑だった**。
 * 🔑 だから写す先は `.git/hooks/` ── ここは checkout でも branch 切替でも変わらない。
 *
 * 🔑 掛け直しは手で覚えなくてよい ── `package.json` の `prepare` が呼ぶので、
 * `npm ci` / `npm install` のたびに入る(箱を立て直すと必ず打つ命令である)。
 *
 * 使い方: node scripts/install-hooks.mjs [--dir <入れる先>] [--quiet]
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOURCE = 'pre-commit';
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const dirFlag = args.indexOf('--dir');

/** git に聞く。git が無い / repo でないときは null(= 黙って何もしない)。 */
function gitPathHooks() {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * ⚠ `core.hooksPath` が立っていると git は**そこだけ**を見る。
 * 🔴 しかも `git rev-parse --git-path hooks` **もその値を返す**ので、
 * 外す前に場所を聞くと、1 稿目の `.githooks`(= 作業ツリーの中)へ写してしまう
 * (2026-09-12 に実際にそうなった)。🔑 **外してから聞く。**
 */
function unsetHooksPath() {
  let cur;
  try {
    cur = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return; // ⚠ 未設定なら `--get` は exit 1 = 何もしない
  }
  if (cur === '') return;
  try {
    execFileSync('git', ['config', '--unset-all', 'core.hooksPath'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!quiet) console.log(`install-hooks: core.hooksPath (${cur}) を外しました`);
  } catch {
    // ⚠ 外せない(読み取り専用の設定)ときは、下の写しが効かないので警告だけ出す
    if (!quiet) console.log(`install-hooks: ⚠ core.hooksPath (${cur}) を外せません`);
  }
}

if (dirFlag < 0) unsetHooksPath();

const target = dirFlag >= 0 ? args[dirFlag + 1] : gitPathHooks();
if (target === undefined || target === null || target === '') {
  // ⚠ 配布 tarball / git の無い箱では何もしない(prepare を失敗させない)
  if (!quiet) console.log('install-hooks: git repo ではないので何もしません');
  process.exit(0);
}

mkdirSync(target, { recursive: true });
const dest = join(target, SOURCE);
copyFileSync(join('.githooks', SOURCE), dest);
chmodSync(dest, 0o755);

if (!quiet) console.log(`install-hooks: ${resolve(dest)} に入れました`);
