/** @vitest-environment node */
/**
 * P7 段③: `launchQueue` の受け口。
 *
 * 🔴 **宣言と実体の parity をここでも縛る**。`manifest.webmanifest` が
 * `file_handlers` を宣言している以上、OS から md をダブルクリックしたときに
 * **実際に entry ができる**ところまでが実体である ── 「受け口の関数がある」
 * だけでは、そこへファイルが届いていない可能性が残る。
 *
 * ⚠ `launchQueue` は実ブラウザの install が要るので smoke では踏めない
 * (設計 doc §3)。**受け口の関数を直接呼ぶ**形で、届く経路そのものを見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  armLaunchQueue,
  type LaunchParamsLike,
  type LaunchTarget,
} from '../../src/adapter/platform/launch-queue';
import {
  MARKDOWN_EXTENSIONS,
  isMarkdownFileName,
} from '../../src/features/import/plain-markdown';

/** 実ブラウザの `launchQueue` を真似る(consumer を保持して後から発火できる)。 */
function fakeTarget(): {
  target: LaunchTarget;
  fire(params: LaunchParamsLike): void;
  hasConsumer(): boolean;
} {
  let consumer: ((p: LaunchParamsLike) => void) | null = null;
  return {
    target: { launchQueue: { setConsumer: (c) => void (consumer = c) } },
    fire: (params) => consumer?.(params),
    hasConsumer: () => consumer !== null,
  };
}

const handleFor = (file: File): { getFile(): Promise<File> } => ({
  getFile: () => Promise.resolve(file),
});

const md = (name: string, body = '# 中身\n'): File => new File([body], name, { type: '' });

/** microtask を全部流す(受け口は内部で await するため)。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('受け口の基本', () => {
  it('launchQueue がある環境では consumer を張る', () => {
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    expect(intake.armed).toBe(true);
    expect(f.hasConsumer()).toBe(true);
  });

  it('launchQueue が無い環境でも壊れない', () => {
    const intake = armLaunchQueue({});
    expect(intake.armed).toBe(false);
    // 受け取り先を差しても何も起きない(例外を投げない)
    expect(() => intake.deliverTo(() => {})).not.toThrow();
  });

  it('ファイルが届いたら受け取り先へ渡す', async () => {
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    f.fire({ files: [handleFor(md('a.md'))] });
    await settle();
    expect(got.flat().map((x) => x.name)).toEqual(['a.md']);
  });

  it('複数ファイルはまとめて渡す(1 件ずつ entry になるのは import 側の仕事)', async () => {
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    f.fire({ files: [handleFor(md('a.md')), handleFor(md('b.markdown'))] });
    await settle();
    expect(got).toHaveLength(1);
    expect(got[0]!.map((x) => x.name)).toEqual(['a.md', 'b.markdown']);
  });
});

describe('🔴 受け口は await より前に張る ── 起動直後の launch を落とさない', () => {
  it('受け取り先が決まる**前**に届いたファイルも、決まった時点で流れる', async () => {
    // ⚠ これが本体。`launchQueue` は起動時に一度だけ値を渡す契約なので、
    // storage の初期化を待ってから登録すると**取りこぼす**
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    f.fire({ files: [handleFor(md('早い.md'))] }); // まだ deliverTo していない
    await settle();

    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    await settle();
    expect(got.flat().map((x) => x.name)).toEqual(['早い.md']);
  });

  it('受け取り先が決まったあとの launch も届く(起動中に別の md を開く)', async () => {
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    f.fire({ files: [handleFor(md('1.md'))] });
    await settle();
    f.fire({ files: [handleFor(md('2.md'))] });
    await settle();
    expect(got.map((batch) => batch.map((x) => x.name))).toEqual([['1.md'], ['2.md']]);
  });

  it('🔴 同じファイルを二重に渡さない(流したら控えは空になる)', async () => {
    // ⚠ 控えを空にしないと、2 通目の launch のたびに**過去のファイルも一緒に
    // 流れて**同じノートが増殖する
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    f.fire({ files: [handleFor(md('a.md'))] });
    await settle();
    f.fire({ files: [handleFor(md('b.md'))] });
    await settle();
    // 2 通目に a.md が混ざらない
    expect(got.map((b) => b.map((x) => x.name))).toEqual([['a.md'], ['b.md']]);
    // 受け取り先を差し直しても、もう控えは無い
    intake.deliverTo((files) => void got.push(files));
    await settle();
    expect(got.flat()).toHaveLength(2);
  });
});

describe('🔴 黙って落とさない', () => {
  it('ファイル無しの launch(通常起動)は何もしない ── **エラーも出さない**', async () => {
    // ⚠ 「呼ばれない」だけを見ると、`params.files` を無ガードで触って
    // TypeError を投げる実装でも通る(呼ばれないのは同じ)── 変異試験で
    // 実際に生き残った。**静かに成功している**ことを見る
    const errors: string[] = [];
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target, (m) => void errors.push(m));
    const consume = vi.fn();
    intake.deliverTo(consume);
    f.fire({});
    f.fire({ files: [] });
    await settle();
    expect(consume).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('読めないファイルは**言う**。残りは開く', async () => {
    const errors: string[] = [];
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target, (m) => void errors.push(m));
    const got: File[][] = [];
    intake.deliverTo((files) => void got.push(files));
    f.fire({
      files: [
        { getFile: () => Promise.reject(new Error('権限がありません')) },
        handleFor(md('生きてる.md')),
      ],
    });
    await settle();
    expect(errors.join('\n')).toContain('権限がありません');
    expect(got.flat().map((x) => x.name)).toEqual(['生きてる.md']); // 残りは開く
  });

  it('全部読めなければ受け取り先を呼ばない(空配列を渡さない)', async () => {
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target, () => {});
    const consume = vi.fn();
    intake.deliverTo(consume);
    f.fire({ files: [{ getFile: () => Promise.reject(new Error('x')) }] });
    await settle();
    expect(consume).not.toHaveBeenCalled();
  });

  it('取込側が失敗しても**言う**(unhandled rejection にしない)', async () => {
    const errors: string[] = [];
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target, (m) => void errors.push(m));
    intake.deliverTo(() => Promise.reject(new Error('書込に失敗')));
    f.fire({ files: [handleFor(md('a.md'))] });
    await settle();
    expect(errors.join('\n')).toContain('書込に失敗');
  });
});

describe('🔴 宣言と実体の parity ── manifest が言う拡張子が実際に entry になる', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf-8'),
  ) as { file_handlers?: Array<{ action?: string; accept?: Record<string, string[]> }> };
  const handlers = manifest.file_handlers ?? [];
  const declared = handlers.flatMap((h) => Object.values(h.accept ?? {}).flat());

  it('manifest が file_handlers を宣言している(空なら parity 検査が空振りする)', () => {
    expect(handlers.length).toBeGreaterThan(0);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('`action` はアプリ自身を指す(別 URL を開くと受け口に届かない)', () => {
    for (const h of handlers) expect(h.action).toBe('./');
  });

  it('🔴 宣言された拡張子は、受け口を通って**取込の規則に届く**', async () => {
    // ⚠ 「受け口の関数がある」だけでは足りない ── そこへ実際にファイルが
    // 流れ、`isMarkdownFileName` が受ける形で届くところまでを見る
    const f = fakeTarget();
    const intake = armLaunchQueue(f.target);
    const delivered: File[] = [];
    intake.deliverTo((files) => void delivered.push(...files));
    f.fire({ files: declared.map((ext) => handleFor(md(`note${ext}`))) });
    await settle();

    expect(delivered.map((x) => x.name)).toEqual(declared.map((ext) => `note${ext}`));
    for (const file of delivered) {
      expect(isMarkdownFileName(file.name), `${file.name} が md として受けられない`).toBe(true);
    }
  });

  it('受け口が扱う拡張子の集合は、受理器と manifest の 3 者で一致する', () => {
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual([...declared].sort());
  });
});
