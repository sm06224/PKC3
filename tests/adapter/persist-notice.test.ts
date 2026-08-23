/** @vitest-environment happy-dom */
/**
 * 🔴 **保存の状態を、設定の面に出す**(#347、user 裁定 2026-08-23)。
 *
 * > 「**#347 で「守られていません」は気になるから見るだけで**」
 *
 * ⚠ **押しかけない**のが裁定である ── 帯にもダイアログにもお知らせにもしない。
 * だからこの面が見るのは 2 つ:**設定に出ること**と、**設定の外に出ないこと**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState } from '../../src/adapter/state/app-state';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';

function paint(over: Partial<AppState>): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  const r = new SettingsRenderer(region);
  r.render({ ...initialState, phase: 'ready', ...over } as AppState);
  return region;
}

const textOf = (region: HTMLElement): string =>
  region.querySelector<HTMLElement>('[data-pkc-field-persist="persist-state"]')?.textContent ?? '';

describe('保存の状態を設定に出す (#347)', () => {
  it('🔴 消えない扱いなら、そう出る', () => {
    expect(textOf(paint({ persistState: 'persisted' }))).toContain('消さない扱い');
  });

  /**
   * 🔴 **断られたら「次の手」まで書く**(user 指示 2026-08-21「画面で何が起きるかで書く」)。
   * ⚠ 「消えることがあります」だけだと、user は不安になるだけで**何もできない**。
   */
  it('🔴 断られたときは、効く手まで書く', () => {
    const t = textOf(paint({ persistState: 'denied' }));
    expect(t, '危険だけ伝えている').toContain('消すことがあります');
    expect(t, '次の手が書かれていない').toContain('ホーム画面');
  });

  it('🔴 口の無いブラウザには、バックアップを勧める', () => {
    const t = textOf(paint({ persistState: 'unsupported' }));
    expect(t).toContain('対応していません');
    expect(t, '次の手が書かれていない').toContain('バックアップ');
  });

  /**
   * 🔴 **まだ頼んでいないのを「断られました」と書かない**(起動直後は必ずここ)。
   * ⚠ 混ぜると、何も悪くない user に**嘘の警告**を出すことになる。
   */
  it('🔴 起動直後は「まだ確かめていません」(断られたとは書かない)', () => {
    const t = textOf(paint({}));
    expect(t).toContain('まだ確かめていません');
    expect(t, '頼む前なのに断られたと書いた').not.toContain('消すことがあります');
  });

  /**
   * 🔴 **器は 1 度しか組まない** ── 映さないと起動直後の字で凍る。
   * ⚠ この repo が何度も踏んでいる形なので、**組み済みの分岐**で見る。
   */
  it('🔴 後から分かったら追いつく(古い字で凍らない)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new SettingsRenderer(region);
    const base = { ...initialState, phase: 'ready' } as AppState;
    r.render(base);
    expect(textOf(region)).toContain('まだ確かめていません');
    r.render({ ...base, persistState: 'denied' } as AppState);
    expect(textOf(region), '2 度目の描画で古い字のまま').toContain('消すことがあります');
  });

  /**
   * 🔴 **押せるものを置かない**(裁定「見るだけで」)。
   * ⚠ ボタンを置くと、それは「押しかけ」の入口になる。
   */
  it('🔴 この行に押せるものは無い', () => {
    const region = paint({ persistState: 'denied' });
    const dd = region.querySelector('[data-pkc-field-persist="persist-state"]')!.parentElement!;
    expect(dd.querySelector('button, input, select'), '押せるものを置いた').toBeNull();
  });
});

/**
 * 🔴 **裁定の「押しかけない」側を機械で守る**(user 2026-08-23「見るだけで」)。
 *
 * ⚠ 上の describe は「**設定に出ること**」を見るが、それだけだと
 * **帯にも出す**実装が緑のまま通る ── 裁定の半分しか守っていない。
 * 🔑 だから**文言が設定の面の外に無いこと**を、原文の全数走査で pin する。
 */
describe('🔒 押しかけない(#347 の裁定の半分)', () => {
  const SRC = 'src';
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [join(dir, e.name)]
          : [],
    );

  /**
   * 🔴 **禁じられているのは「user の状態を設定の外で告げること」**である
   * (裁定「見るだけで」)。
   *
   * ⚠ 1 稿目は `消さない扱い` という**語**で採ったが、**お知らせに当たった** ──
   *   お知らせは「**設定にその行が増えた**」という告知で、user の状態は言っていない。
   *   ⚠ そして user に見える変更をお知らせに載せるのは**規律で要求されている**
   *   (CLAUDE.md PR 運用)ので、語で採るガードは**正しい実装を落とす**。
   * 🔑 だから採るのは**状態文そのもの**(全文一致)にする ── 「これは在るか」ではなく
   *   「**この文が別の面から出ていないか**」が主張である。
   *
   * 🔴 そして `PERSIST_TEXT` は **export しない** ── 型で塞げば、
   *   別の面が**同じ文を出す道が構文上に無い**。⚠ 字面のガードは
   *   「写した」ときにしか効かないので、両方要る(CLAUDE.md §1
   *   「ガードは代替物で満たせない条件にする」)。
   */
  const STATUS_SENTENCES = [
    'このブラウザは、このアプリのデータを消さない扱いにしています。',
    '空き容量が足りなくなると、このブラウザがデータを消すことがあります。',
    'このブラウザは、消さない扱いに対応していません。',
    'まだ確かめていません。最初に何か保存したときに確かめます。',
  ];

  it('🔴 状態の文は `settings.ts` にしか無い(帯・お知らせに出さない)', () => {
    const files = walk(SRC).map((f) => [f, readFileSync(f, 'utf-8')] as const);
    const only = join('src', 'adapter', 'ui', 'render', 'settings.ts');
    for (const sentence of STATUS_SENTENCES) {
      const hits = files.filter(([, body]) => body.includes(sentence)).map(([f]) => f);
      // 空振り防止 ── 1 件も無いなら、この検査は何も守っていない
      expect(hits.length, `状態の文が 1 つも見つからない(検査が空振り): ${sentence}`).toBe(1);
      expect(hits, `設定の面の外に状態の文が出ている: ${sentence}`).toEqual([only]);
    }
  });

  /** 🔴 **型で塞ぐ側** ── `PERSIST_TEXT` を外へ出さない(出すと別の面が使える)。 */
  it('🔴 `PERSIST_TEXT` は export されていない', () => {
    const src = readFileSync(join('src', 'adapter', 'ui', 'render', 'settings.ts'), 'utf-8');
    expect(src, '前提: 文言の表が無い').toContain('const PERSIST_TEXT');
    expect(src, '文言の表を外へ出した(別の面が同じ文を出せる)').not.toContain(
      'export const PERSIST_TEXT',
    );
  });

  /**
   * 🔴 **起動では尋ねない。** `persist()` は user に尋ねうる口なので、
   * 起動で呼ぶと**まだ何も持っていない user に断る理由しかない瞬間**で聞くことになる。
   * ⚠ 見るのは**実行する行** ── コメントに満たされないよう `probe` の呼び出しで採る。
   */
  it('🔴 起動時に呼ぶのは `probe`(尋ねない口)であって `ensure` ではない', () => {
    const src = readFileSync(join('src', 'adapter', 'state', 'store-effects.ts'), 'utf-8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code, '起動の問い合わせが無い').toContain('persistOnce.probe()');
    // ⚠ `ensure` は**書込の ack のところにだけ**在る(1 件)
    expect(
      code.split('persistOnce.ensure()').length - 1,
      '`ensure`(尋ねうる口)が書込の ack 以外から呼ばれている',
    ).toBe(1);
  });
});

describe('PERSIST_STATE の畳み方 (#347)', () => {
  it('🔴 状態を持つ', () => {
    const { state } = reduce(initialState, { type: 'PERSIST_STATE', state: 'denied' });
    expect(state.persistState).toBe('denied');
  });

  /**
   * ⚠ **同じなら state を差し替えない** ── 差し替えると指紋が変わり、
   * 関係の無い面が組み直される。
   */
  it('⚠ 同じ状態なら state を差し替えない', () => {
    const a = reduce(initialState, { type: 'PERSIST_STATE', state: 'denied' }).state;
    const b = reduce(a, { type: 'PERSIST_STATE', state: 'denied' }).state;
    expect(b, '同じ値で state を作り直した').toBe(a);
  });
});
