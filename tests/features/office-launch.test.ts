/** @vitest-environment node */
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
  localSaveFailedNotice,
  openingNotice,
  stagedLaunchNotice,
} from '../../src/features/office/office-launch';
import {
  isOfficeAttachment,
  isOfficeUsable,
  officeEntry,
  type OfficeCapability,
} from '../../src/features/office/office-entry';
import { sanitizeMessageText } from '../../src/features/message/message-log';

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
    // 🔴 ファイル名は引用符で囲んである ── メッセージへ積むとき名前が残らない(#1017 C5)
    expect(sanitizeMessageText(s), 'ファイル名がメッセージに残る').not.toContain('報告書');
    expect(s, 'どこへ保存されるか書いていない').toContain('元のファイル');
  });

  it('🔴 書き戻せないときは、開く前に断る(黙って落とさない)', () => {
    const s = cannotWriteBackNotice('報告書.docx');
    expect(s).toContain('報告書.docx');
    expect(sanitizeMessageText(s), 'ファイル名がメッセージに残る').not.toContain('報告書');
    expect(s).toContain('書き戻せません');
  });
});

const CAP_OK: OfficeCapability = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
};

describe('Office を押した時点の知らせ(書き戻せるかで言い分ける)', () => {
  it('🔴 書き込めないファイルに「書き戻します」と言わない。書けるなら言う', () => {
    expect(openingNotice('a.docx', true)).toBe(localOpenNotice('a.docx'));
    expect(openingNotice('a.docx', false)).toBe(cannotWriteBackNotice('a.docx'));
    expect(openingNotice('a.docx', false), '書けないのに書き戻すと言っている').not.toContain('書き戻します');
  });
});

describe('OS から Office のファイルを渡されたときの知らせ', () => {
  const base = { fileName: '報告書.docx', writable: true, packInstalled: true, capability: CAP_OK };

  it('動かせて一式が入っていれば、従来どおり「Office」を押させる(押す先にタイルが在る)', () => {
    expect(stagedLaunchNotice(base)).toContain('アプリの「Office」を押してください');
    expect(stagedLaunchNotice({ ...base, writable: false })).toBe(cannotWriteBackNotice('報告書.docx'));
  });

  it('🔴 一式が無い端末ではタイルが無いので押させず、取り込む道を案内する', () => {
    const m = stagedLaunchNotice({ ...base, packInstalled: false });
    expect(m).not.toContain('「Office」を押');
    expect(m).toContain('システム → 保存領域 → Office 表示');
    expect(m).toContain('約');
  });

  it('🔴 動かないブラウザでは、動くブラウザを案内する(一式の有無より先)', () => {
    for (const lack of ['crossOriginIsolated', 'sharedArrayBuffer', 'jspi', 'decompressionStream'] as const) {
      const m = stagedLaunchNotice({ ...base, packInstalled: false, capability: { ...CAP_OK, [lack]: false } });
      expect(m, lack).toContain('Chrome か Edge');
      expect(m, `${lack}: 動かない環境に取り込みを促している`).not.toContain('取り込んでください');
    }
  });

  it('ファイル名は引用符で囲んである(メッセージへ積むとき名前が残らない)', () => {
    for (const m of [
      stagedLaunchNotice(base),
      stagedLaunchNotice({ ...base, packInstalled: false }),
      stagedLaunchNotice({ ...base, capability: { ...CAP_OK, jspi: false } }),
    ]) {
      expect(sanitizeMessageText(m), '名前が残る').not.toContain('報告書');
    }
  });
});

describe('タイルを出す規則は添付の入口と同じ', () => {
  it('🔴 isOfficeUsable は、添付の入口が「押せる」になる条件と全数で一致する', () => {
    let usable = 0;
    for (let bits = 0; bits < 32; bits += 1) {
      const capability: OfficeCapability = {
        crossOriginIsolated: (bits & 1) !== 0,
        sharedArrayBuffer: (bits & 2) !== 0,
        jspi: (bits & 4) !== 0,
        decompressionStream: (bits & 8) !== 0,
      };
      const packInstalled = (bits & 16) !== 0;
      const open = officeEntry({ mime: '', fileName: 'a.docx', packInstalled, capability }).kind === 'open';
      expect(isOfficeUsable(packInstalled, capability), `bits=${bits}`).toBe(open);
      if (open) usable += 1;
    }
    expect(usable, '押せる組み合わせが 1 つに限られない/0 でない').toBe(1);
  });
});

describe('元のファイルへ書き戻せなかった知らせ', () => {
  it('🔴 理由ごとに言い分け、どの理由でも行方を 1 文で言う', () => {
    const rows: [Parameters<typeof localSaveFailedNotice>[1], string][] = [
      ['denied', '許可が得られなかった'],
      ['reopen', '開き直す必要があります'],
      ['unsupported', 'このブラウザでは元のファイルへ書き戻せません'],
    ];
    for (const [r, phrase] of rows) {
      const m = localSaveFailedNotice('報告書.docx', r);
      expect(m, String(r)).toContain(phrase);
      expect(m, String(r)).toContain('編集した内容は PKC3 の中に残してあります');
      expect(sanitizeMessageText(m)).not.toContain('報告書');
    }
    const none = localSaveFailedNotice('報告書.docx', null);
    expect(none).toContain('編集した内容は PKC3 の中に残してあります');
    expect(none, '理由が分からないのに理由を言っている').not.toMatch(/許可|開き直す|このブラウザ/);
  });
});

describe('main.ts の配線(原文 pin。main.ts は実行されないので弱い)', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  it('タイルは isOfficeUsable で出し分け、押した時点・受け取った時点の知らせは取り出した関数を通る', () => {
    expect(main).toContain('officeInstalled: () => isOfficeUsable(appOfficePack.isInstalled(), appOfficePack.capability())');
    expect(main).toContain('openingNotice(staged.name, staged.writable)');
    expect(main).toContain('stagedLaunchNotice({');
    expect(main, '一式の有無を起動直後の控えから読んでいる').toContain('await officeInstaller.readMeta()');
  });
});
