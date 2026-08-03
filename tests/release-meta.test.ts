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

/**
 * 🔴 **コメントを落としてから突合する**。workflow の説明コメントには
 * `--draft=false` や `pkc3-dist.zip` といった**当の文字列がそのまま書いてある**ので、
 * 素の本文に `toContain` を当てると **説明文に救われる** ── 実際に、
 * 「draft にせず公開する」「draft のまま公開しない」の変異が**2 件とも生き残った**
 * (CLAUDE.md「ガードは代替物で満たせない条件にする」)。
 */
function stripComments(yaml: string): string {
  return yaml.replace(/^\s*#.*$/gm, '');
}

describe('🔴 release workflow が版と provenance を担保する', () => {
  const wfRaw = readFileSync('.github/workflows/release.yml', 'utf-8');
  const wf = stripComments(wfRaw);

  /** attest step の本文だけを切り出す(次の step の `- name:` まで)。 */
  function attestStep(): string {
    const at = wf.indexOf('actions/attest-build-provenance');
    if (at < 0) return '';
    const rest = wf.slice(at);
    const end = rest.search(/\n\s{6}- (?:name|run|uses):/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  /**
   * `gh release create` の**文だけ**を切り出す(行継続の `\\` を畳む)。
   * ⚠ 全文に当てると **次の行の `--draft=false` に救われる** ── 「create に
   * `--draft` が無い」変異が、コメントを落としてもなお生き残った。
   */
  function createCommand(): string {
    const at = wf.indexOf('gh release create');
    if (at < 0) return '';
    let out = '';
    for (const line of wf.slice(at).split('\n')) {
      out += line.trimEnd().replace(/\\$/, ' ');
      if (!line.trimEnd().endsWith('\\')) break;
    }
    return out;
  }

  /** `gh release create` に渡している成果物(= user が受け取る物)。 */
  function releasedArtifacts(): string[] {
    const line = /gh release create "\$TAG" (.*?) \\/.exec(wf)?.[1] ?? '';
    return line.split(/\s+/).filter(Boolean);
  }

  it('tag と package.json の突合を **build より前**に行う', () => {
    // ⚠ 後ろに置くと、食い違ったまま**ビルドして検品まで通ってしまう**
    // (落ちるのは最後の gh release create なので、時間と CI を捨てる)
    const check = wf.indexOf('TAG=v$VER');
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
    const pages = stripComments(readFileSync('.github/workflows/pages.yml', 'utf-8'));
    const tagLine = /TAG=\$\(git tag[^\n]*/.exec(pages)?.[0] ?? '';
    expect(tagLine, 'product tag の解決行が無い').not.toBe('');
    // ⚠ 綴りは release.yml の prerelease 判定と**同じ集合**であること
    const kinds = [...(/case "\$TAG" in\s*\n\s*([^)]+)\)/.exec(wf)?.[1] ?? '')
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

  /**
   * 🔴 **手で押せる口**(2026-08-03)。tag push だけにしておくと、tag を push できない
   * 環境から**出荷そのものができない**(実際に git proxy が tag を 403 で拒んだ)。
   * ⚠ Releases 画面から release を作る道は罠 ── その tag でこの workflow が走り、
   * `gh release create` が「もう在る」で落ちる。入口は 1 本に保つ。
   */
  describe('手動起動', () => {
    /** `workflow_dispatch` 起動でだけ走る前提確認 step の本文。 */
    function guardStep(): string {
      const at = wf.indexOf('手動起動の前提を確かめる');
      if (at < 0) return '';
      const rest = wf.slice(at);
      const end = rest.search(/\n\s{6}- (?:name|run|uses):/);
      return end < 0 ? rest : rest.slice(0, end);
    }

    it('版を入力して押せる', () => {
      expect(wf).toContain('workflow_dispatch');
      expect(wf, '版の入力口が無い').toMatch(/inputs:\s*\n\s*version:/);
    });

    it('🔴 入力を shell へ**直接展開しない**(script injection を作らない)', () => {
      // ⚠ `run: |` の中に `${{ inputs.version }}` を書くと、入力がそのまま
      // shell の一部になる。必ず `env:` を経由して `"$INPUT_VERSION"` で受ける
      const runs = [...wfRaw.matchAll(/run: \|([\s\S]*?)(?=\n\s{6}- |\n\s{4}\w|$)/g)].map(
        (m) => m[1]!,
      );
      for (const body of runs) {
        expect(body, 'run の中で入力を直接展開している').not.toMatch(
          /\$\{\{\s*(inputs|github\.event\.inputs)\./,
        );
      }
      expect(wf, '入力を env 経由で受けていない').toContain('INPUT_VERSION: ${{ inputs.version }}');
    });

    it('🔴 手動起動は **main からだけ**', () => {
      // ⚠ 別 branch から打つと、tag が指す commit と `pages.yml` が焼く
      // `/dev/`(main HEAD)がずれる
      const guard = guardStep();
      expect(guard, '前提確認の step が無い').not.toBe('');
      expect(guard).toContain('refs/heads/main');
      expect(guard).toContain('exit 1');
      expect(wf).toContain("if: github.event_name == 'workflow_dispatch'");
    });

    it('🔴 既にある版への**打ち直しを拒む**', () => {
      // ⚠ 拒まないと、同じ版で別 commit を黙って出荷できる
      const guard = guardStep();
      expect(guard).toContain('git/ref/tags/$TAG');
      expect(guard).toContain('既にあります');
    });

    it('🔴 tag は **この commit** に付く(`--target`)', () => {
      // ⚠ 手動起動では tag がまだ無く、draft のうちは ref も作られない。
      // `--target` が無いと**既定 branch の HEAD**に付き、
      // 検品した成果物と tag が指す木が食い違う
      expect(createCommand()).toContain('--target "$GITHUB_SHA"');
    });
  });

  it('🔴 Pages は **attest した成果物そのもの**を配る(再ビルドしない)', () => {
    // round-2 review M-4: 以前は同じ tag を別 job で**もう一度ビルド**していたので、
    // Pages に出る物と attestation を付けた物が**別の成果物**だった ──
    // 「配る物そのものに provenance を付ける」が Pages 経路で成立していなかった。
    // 段⑧ で release の zip を展開してそのまま配る形にした
    const pages = stripComments(readFileSync('.github/workflows/pages.yml', 'utf-8'));
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

  it('🔴 資産を上げ切ってから公開する(Pages が空振りしない)', () => {
    // `gh release create` は**公開してから資産を上げる**ので、
    // `release: published` を待つ `pages.yml` が **zip が届く前に走りうる** ──
    // asset が見つからず placeholder を配って終わり、次の main push まで
    // `/` が空のままになる。draft のうちに上げ切ってから公開すれば競合が消える
    expect(createCommand(), 'draft で作っていない').toMatch(/--draft(?!=)/);
    const publish = wf.indexOf('--draft=false');
    expect(publish, 'draft を公開していない(release が draft のまま残る)').toBeGreaterThan(-1);
    expect(wf.indexOf('gh release create')).toBeLessThan(publish);
  });

  it('🔴 release の後に Pages を**明示的に起こす**(published は飛ばない)', () => {
    // round-3 review M-1: GitHub Actions は**既定の `GITHUB_TOKEN` が起こした
    // イベントで新しい run を開始しない** ── `pages.yml` の
    // `release: types: [published]` は、この workflow が作った release では
    // **一度も走らない**。気づかないと「tag を打ったのに `/` が placeholder のまま」
    expect(wf, 'Pages を起こしていない').toContain('gh workflow run pages.yml');
    // ⚠ 権限が無いと dispatch は 403 で落ちる
    expect(wf).toContain('actions: write');
    // ⚠ 公開より**後**に起こす(先に起こすと資産がまだ無い)
    expect(wf.indexOf('--draft=false')).toBeLessThan(wf.indexOf('gh workflow run'));
    // dispatch を受ける口が pages 側にあること
    const pages = stripComments(readFileSync('.github/workflows/pages.yml', 'utf-8'));
    expect(pages, 'pages.yml が workflow_dispatch を受けない').toContain('workflow_dispatch');
  });

  it('🔴 安定 tag が在るのに product を配れないなら**落とす**(静かに placeholder にしない)', () => {
    // round-3 review H-2: `gh` の失敗が「release が無い」に化けて placeholder へ
    // 落ちると、`_site` の root から `sw.js` / `manifest` / `icon` が**消える** ──
    // navigation は network-first なので既存 user にも placeholder が届き、
    // `/sw.js` の 404 は**登録解除の合図**として扱われる(オフライン能力ごと落ちる)
    const pages = stripComments(readFileSync('.github/workflows/pages.yml', 'utf-8'));
    // placeholder は「tag が無い」枝でしか使わない
    const placeholderAt = pages.indexOf('pages-placeholder.html');
    const emptyTagAt = pages.indexOf('if [ -z "$TAG" ]');
    expect(emptyTagAt, 'tag 不在の枝が無い').toBeGreaterThan(-1);
    expect(emptyTagAt).toBeLessThan(placeholderAt);
    // 照会の失敗と資産の不在で **exit 1** する
    expect((pages.match(/exit 1/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ⚠ 1 本の条件に混ぜ戻していないこと(pipefail が無いと失敗が 1 に化ける)
    expect(pages).not.toMatch(/\[ -n "\$TAG" \][^\n]*&&[^\n]*gh release view/);
  });

  it('product の検品を通してから release する', () => {
    // 段① の最終関門(map 入りを配らない)を外さない
    expect(wf).toContain('check-dist.mjs product');
    expect(wf.indexOf('check-dist.mjs product')).toBeLessThan(wf.indexOf('gh release create'));
  });
});
