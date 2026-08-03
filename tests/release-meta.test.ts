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
    // ⚠ 対象を書き忘れると attestation は「何も証明しない」形で通る
    expect(wf).toContain('pkc3-dist.zip');
    expect(wf).toContain('pkc3-sbom.cdx.json');
    const attest = wf.indexOf('actions/attest-build-provenance');
    const subject = wf.indexOf('subject-path', attest);
    expect(subject).toBeGreaterThan(attest);
  });

  it('product の検品を通してから release する', () => {
    // 段① の最終関門(map 入りを配らない)を外さない
    expect(wf).toContain('check-dist.mjs product');
    expect(wf.indexOf('check-dist.mjs product')).toBeLessThan(wf.indexOf('gh release create'));
  });
});
