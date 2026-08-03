/** @vitest-environment node */
/**
 * P7 段⑦: 名乗る版と配る版を食い違わせない。
 *
 * 🔴 版は **3 か所**に居る ── `package.json`(SBOM と npm が見る)/
 * `release-meta.ts`(画面下の status と provenance の刻印)/ **release tag**
 * (Pages の `/` が何を配るかを決める)。1 か所だけ上げるのは**必ず起きる**ので、
 * 機械で縛る。tag との突合は release workflow が build 前にやる
 * (ここでは tag を知りようがない ── 「知らない次元は測っていない次元」)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_ID, APP_VERSION, SCHEMA_VERSION } from '../src/runtime/release-meta';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  name: string;
  version: string;
};

describe('版の刻印', () => {
  it('🔴 package.json の version と APP_VERSION が一致する', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('APP_ID が package 名と一致する', () => {
    expect(APP_ID).toBe(pkg.name);
  });

  it('版は semver(release workflow が `v<version>` の tag を要求する)', () => {
    // ⚠ `3.0.0-dev` のような開発版のまま release すると、tag と食い違って
    // workflow が落ちる ── 落ちるのが正しい
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('schema version は整数(DB の互換判定に使う)', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe('🔴 release workflow が版と provenance を担保する', () => {
  const wf = readFileSync('.github/workflows/release.yml', 'utf-8');

  /** attest step の本文だけを切り出す(次の step の `- name:` まで)。 */
  function attestStep(): string {
    const at = wf.indexOf('actions/attest-build-provenance');
    if (at < 0) return '';
    const rest = wf.slice(at);
    const end = rest.search(/\n\s{6}- (?:name|run|uses):/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  /** `gh release create` に渡している成果物(= user が受け取る物)。 */
  function releasedArtifacts(): string[] {
    const line = /gh release create "\$GITHUB_REF_NAME" (.*?) \\/.exec(wf)?.[1] ?? '';
    return line.split(/\s+/).filter(Boolean);
  }

  it('tag と package.json の突合を **build より前**に行う', () => {
    // ⚠ 後ろに置くと、食い違ったまま**ビルドして検品まで通ってしまう**
    // (落ちるのは最後の gh release create なので、時間と CI を捨てる)
    const check = wf.indexOf('GITHUB_REF_NAME#v');
    const build = wf.indexOf('VITE_PKC_KIND=product npm run build');
    expect(check).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeLessThan(build);
  });

  it('🔴 provenance attestation を出す(何をどこで作ったかを検証できる)', () => {
    expect(wf).toContain('actions/attest-build-provenance');
    // ⚠ 権限が無いと attestation の step は落ちる ── 3 つとも要る
    expect(wf).toContain('id-token: write');
    expect(wf).toContain('attestations: write');
  });

  it('🔴 attestation の対象が**配る物そのもの**である', () => {
    // ⚠ 対象を書き忘れると attestation は「何も証明しない」形で通る。
    // 🔴 かつて `wf.toContain('pkc3-dist.zip')` で見ていたが、その語は
    // `zip -r` / `npm sbom >` / `gh release create` の各行にも在るので、
    // **`subject-path` を `README.md` に置換しても全緑**だった
    // (round-2 review M-3)── CLAUDE.md「ガードは代替物で満たせない条件にする」。
    // → **attest step の中だけ**を切り出して、その中で突き合わせる
    const step = attestStep();
    expect(step, 'attest step が見つからない').not.toBe('');
    expect(step).toContain('subject-path');
    for (const artifact of releasedArtifacts()) {
      expect(step, `attest していない出荷物: ${artifact}`).toContain(artifact);
    }
  });

  it('🔴 attest する物と release に添付する物が**同じ集合**である', () => {
    // ⚠ 片方だけ増やす事故を止める(attest されない物を配る / 配らない物を attest する)
    const step = attestStep();
    const listed = [...step.matchAll(/^\s{10,}(\S+)$/gm)].map((m) => m[1]!);
    expect([...listed].sort()).toEqual([...releasedArtifacts()].sort());
  });

  it('🔴 Pages の `/` は prerelease を配らない(同じ綴りで揃える)', () => {
    // round-2 review M-5: git の既定 `v:refname` は prerelease を**上位に**並べる
    // ── `v3.0.0` と `v3.0.0-rc1` が在ると `head -1` は **rc のほう**(実証済み)。
    // 段⑦ で release.yml が prerelease を正式に扱えるようにしたので、この経路は
    // **今回新たに到達可能**になった。RC を打った瞬間 `/` が RC に差し替わる
    const pages = readFileSync('.github/workflows/pages.yml', 'utf-8');
    const tagLine = /TAG=\$\(git tag[^\n]*/.exec(pages)?.[0] ?? '';
    expect(tagLine, 'product tag の解決行が無い').not.toBe('');
    // ⚠ 綴りは release.yml の prerelease 判定と**同じ集合**であること
    const kinds = [...(/case "\$GITHUB_REF_NAME" in\s*\n\s*([^)]+)\)/.exec(wf)?.[1] ?? '')
      .matchAll(/-([a-z]+)\*/g)].map((m) => m[1]!);
    expect(kinds.length, 'release.yml の prerelease 判定が読めない').toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(tagLine, `pages.yml が ${kind} を除外していない`).toContain(kind);
    }
  });

  it('🔴 release は **CI と同じ gate** を自分で走らせる', () => {
    // round-2 review L-3: `ci.yml` の trigger は main への push と PR だけで、
    // **tag push では走らない** ── ここで走らせないと、CI を通っていない commit に
    // tag を打てば `APP_VERSION` 不一致のまま出荷できる。
    // ⚠ 「CI を長くしない」は **PR gate** の話であり、release は稀なので載せてよい
    const build = wf.indexOf('VITE_PKC_KIND=product npm run build');
    for (const gate of ['npm run typecheck', 'npm run lint', 'npm test']) {
      const at = wf.indexOf(`run: ${gate}`);
      expect(at, `release が ${gate} を走らせない`).toBeGreaterThan(-1);
      expect(at, `${gate} が build より後ろにある`).toBeLessThan(build);
    }
  });

  it('🔴 Pages は **attest した成果物そのもの**を配る(再ビルドしない)', () => {
    // round-2 review M-4: 以前は同じ tag を別 job で**もう一度ビルド**していたので、
    // Pages に出る物と attestation を付けた物が**別の成果物**だった ──
    // 「配る物そのものに provenance を付ける」が Pages 経路で成立していなかった。
    // 段⑧ で release の zip を展開してそのまま配る形にした
    const pages = readFileSync('.github/workflows/pages.yml', 'utf-8');
    const [artifact] = releasedArtifacts().filter((a) => a.endsWith('.zip'));
    expect(artifact, 'release が zip を添付していない').toBeTruthy();
    expect(pages, `pages が ${artifact} を落としていない`).toContain(artifact);
    expect(pages).toContain('gh release download');
    // ⚠ **再ビルドに戻していない**こと(戻すと attest が意味を失う)
    expect(pages).not.toContain('git worktree add');
    expect(pages, 'product を再ビルドしている').not.toContain('VITE_PKC_KIND=product npm run build');
    // ⚠ 配る直前の検品も外さない(展開の取り違えはここでしか捕まらない)
    expect(pages).toMatch(/check-dist\.mjs product \S+/);
    // 🔴 **`_site` を product として検品しない**。この時点の `_site` には既に
    // `dev/`(map 込み)が入っているので、**dev の map を product の出荷物として
    // 数えて必ず落ちる**(実測: ファイル 21 件 / map 3 件 / cap 854.8 KB 超過)。
    // product だけを単独で検品してから合流させる
    expect(pages, '_site をそのまま product として検品している').not.toContain(
      'check-dist.mjs product _site',
    );
    expect(pages, 'product を _site へ直に展開している').not.toMatch(/unzip[^\n]*-d _site/);
  });

  it('product の検品を通してから release する', () => {
    // 段① の最終関門(map 入りを配らない)を外さない
    expect(wf).toContain('check-dist.mjs product');
    expect(wf.indexOf('check-dist.mjs product')).toBeLessThan(wf.indexOf('gh release create'));
  });
});
