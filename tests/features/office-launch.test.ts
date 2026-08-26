/**
 * 🔴 **手元のファイルを Office へ回す振り分け**(#432)。
 *
 * ⚠ ここでいちばん大事なのは、**manifest と振り分けが同じ集合を持っていること**。
 *   片方だけ足すと `.docx` が **markdown として取り込まれる**(文字化けしたノートに
 *   なる)── 直したつもりで、いちばん痛い形になる。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OFFICE_LAUNCH_EXTS,
  cannotWriteBackNotice,
  isLocalFileToken,
  isOfficeLaunchFile,
  localFileId,
  localFileToken,
  localOpenNotice,
} from '../../src/features/office/office-launch';
import { isOfficeAttachment } from '../../src/features/office/office-entry';

describe('振り分け', () => {
  it('Office の拡張子は Office へ回す', () => {
    for (const ext of OFFICE_LAUNCH_EXTS) {
      expect(isOfficeLaunchFile(`報告書${ext}`), `${ext} を回していない`).toBe(true);
    }
  });

  it('🔴 markdown は回さない(取り込みの動線を横取りしない)', () => {
    expect(isOfficeLaunchFile('メモ.md')).toBe(false);
    expect(isOfficeLaunchFile('メモ.markdown')).toBe(false);
  });

  it('🔴 csv は回さない(PKC3 が自前で表として描く)', () => {
    expect(isOfficeLaunchFile('売上.csv')).toBe(false);
  });

  it('大小を無視する(OS から来る名前は .DOCX のこともある)', () => {
    expect(isOfficeLaunchFile('報告書.DOCX')).toBe(true);
  });

  it('⚠ 拡張子の途中に在るだけでは回さない', () => {
    expect(isOfficeLaunchFile('docx の書き方.md')).toBe(false);
  });

  /**
   * 🔴 **`isOfficeAttachment` と別の規則である**(`office-entry.ts` の冒頭が
   * 「この規則を流用するな」と戒めている)。
   *
   * ⚠ あちらは**広く拾う**(入口を出すかの判断)。こちらは**狭く当てる**
   *   (markdown を Office へ流さないため)。⚠ 実際に食い違う綴りが在ることを
   *   見ておく ── 見ないと「同じ物を 2 つ書いただけ」に劣化していても気づけない。
   */
  it('🔴 添付の入口の規則より**狭い**(誤差の向きが違う)', () => {
    const widerOnly = ['.odg', '.fodt', '.fods', '.fodp'];
    for (const ext of widerOnly) {
      expect(isOfficeAttachment('', `a${ext}`), `前提が崩れている: ${ext}`).toBe(true);
      expect(isOfficeLaunchFile(`a${ext}`), `${ext} まで回している(広すぎる)`).toBe(false);
    }
  });

  it('⚠ MIME は見ない(OS 経由で octet-stream に落ちても取り違えない)', () => {
    // 名前が md なら、どんな MIME でも markdown 側である
    expect(isOfficeLaunchFile('メモ.md')).toBe(false);
  });
});

/**
 * 🔴 **manifest と振り分けが同じ集合**(#432)。
 *
 * OS が渡してくるのは manifest が宣言した種類だけなので、ここがずれると
 * 「届くのに知らない」= markdown として取り込む、が静かに起きる。
 */
describe('manifest との突合', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
    file_handlers?: { accept: Record<string, string[]> }[];
  };
  const declared = (manifest.file_handlers ?? []).flatMap((h) =>
    Object.values(h.accept).flat(),
  );

  it('空振り防止 ── manifest が実際に宣言している', () => {
    expect(declared.length, 'file_handlers が空(この突合は何も見ていない)').toBeGreaterThan(2);
  });

  it('🔴 Office の宣言と振り分けが**集合で一致**する', () => {
    /**
     * ⚠ **件数ではなく集合で見る**(CLAUDE.md §8)── 同じ数だけ取り違えても
     *   件数は合う。⚠ **両方向を見る**:manifest にしか無い = 取り込みが
     *   化ける / 振り分けにしか無い = 届かないのに直したつもりになる。
     */
    const md = ['.md', '.markdown'];
    const officeDeclared = declared.filter((e) => !md.includes(e)).sort();
    expect(officeDeclared).toEqual([...OFFICE_LAUNCH_EXTS].sort());
  });

  it('⚠ markdown の関連付けを落としていない(既存の動線を壊さない)', () => {
    expect(declared).toContain('.md');
    expect(declared).toContain('.markdown');
  });

  it('宣言した全部が、振り分けでも Office へ回る', () => {
    for (const ext of declared) {
      if (ext === '.md' || ext === '.markdown') continue;
      expect(isOfficeLaunchFile(`a${ext}`), `manifest に在るのに回らない: ${ext}`).toBe(true);
    }
  });
});

/**
 * 🔴 **合言葉の名前空間**(#432 段②)。
 * ⚠ lid と衝突すると、user の文書が**知らないノートへ上書きされる**。
 */
describe('手元のファイルの合言葉', () => {
  it('作って、それと分かって、id を取り出せる', () => {
    const t = localFileToken('abc');
    expect(isLocalFileToken(t)).toBe(true);
    expect(localFileId(t)).toBe('abc');
  });

  it('🔴 lid の綴りとは絶対に衝突しない(`:` を含む)', () => {
    /**
     * ⚠ `generateLid()` は `${base36}-${base36}` なので `:` を持たない。
     *   ここが崩れると、手元のファイルの保存が**ノートを上書きする**。
     */
    const lidLike = 'mta73ihn-0001';
    expect(isLocalFileToken(lidLike), 'lid を手元のファイルと読んだ').toBe(false);
    expect(localFileId(lidLike)).toBeNull();
    expect(localFileToken('x')).toContain(':');
  });

  it('合言葉なし(空文字)は手元のファイルではない', () => {
    expect(isLocalFileToken('')).toBe(false);
  });
});

describe('文言', () => {
  it('🔴 どこへ保存されるかを、開く前に言う', () => {
    const s = localOpenNotice('報告書.docx');
    expect(s).toContain('報告書.docx');
    expect(s, 'どこへ保存されるか書いていない').toContain('元のファイル');
  });

  it('🔴 書き戻せないときは、開く前に断る(黙って落とさない)', () => {
    const s = cannotWriteBackNotice('報告書.docx');
    expect(s).toContain('報告書.docx');
    expect(s).toContain('書き戻せません');
  });
});
