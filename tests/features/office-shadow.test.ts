/**
 * 🔴 **Office の編集の控え(影)を、次に開くとき戻せるか**の判断(#1228 段 2)。
 *
 * 裁定(Gemini): Q1 = A(次に「Office で開く」を押したとき必ず訊く。選択肢は 2 つ)/ Q2 = A(7 日)。
 * ⚠ 字は裁定どおり ── 変えると、裁定を読んだ人が画面で見つけられない。
 */
import { describe, expect, it } from 'vitest';
import {
  SHADOW_DIALOG_TITLE,
  SHADOW_GONE_NOTICE,
  SHADOW_MAX_AGE_MS,
  SHADOW_OPENED_NOTICE,
  SHADOW_OPEN_SAVED_LABEL,
  SHADOW_OPEN_SHADOW_LABEL,
  isShadowExpired,
  isShadowNewer,
  parseShadowName,
  shadowAgo,
  shadowDialogNote,
  shadowShelfId, attachmentSavedAt } from '../../src/features/office/office-shadow';
import { BANNED_TERMS } from '../../src/features/ui-terms';

describe('訊くべきか(控えが正本の添付より新しいときだけ)', () => {
  it('新しければ訊く / 同じ時刻・古ければ訊かない / 正本の時刻が分からなければ訊く側へ倒す', () => {
    expect(isShadowNewer(2000, 1000)).toBe(true);
    expect(isShadowNewer(1000, 1000), '同じ時刻を訊いた').toBe(false);
    expect(isShadowNewer(999, 1000)).toBe(false);
    expect(isShadowNewer(1, null), '分からないのに黙って見送った').toBe(true);
    expect(isShadowNewer(1, Number.NaN)).toBe(true);
  });

  it('上限は 7 日(裁定 Q2 = A)。ちょうど 7 日はまだ残す', () => {
    expect(SHADOW_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const now = 10 * SHADOW_MAX_AGE_MS;
    expect(isShadowExpired(now - SHADOW_MAX_AGE_MS, now)).toBe(false);
    expect(isShadowExpired(now - SHADOW_MAX_AGE_MS - 1, now)).toBe(true);
  });
});

describe('棚の名前と控えの名前', () => {
  it('lid → 棚の名前: 綴りを潰す / 80 字で切る / 空・手元の file は持たない', () => {
    expect(shadowShelfId('lid-1')).toBe('lid-1');
    expect(shadowShelfId('a b/c')).toBe('a_b_c');
    expect(shadowShelfId('x'.repeat(100))).toHaveLength(80);
    expect(shadowShelfId('')).toBeNull();
    expect(shadowShelfId('local:12')).toBeNull();
  });

  it('控えの名前は 13 桁の時刻 + 拡張子だけ(meta.json などを取り違えない)', () => {
    expect(parseShadowName('1800000000000.docx')).toEqual({ at: 1_800_000_000_000, ext: 'docx' });
    expect(parseShadowName('1800000000000.ODT')).toEqual({ at: 1_800_000_000_000, ext: 'odt' });
    for (const n of ['meta.json', '180000000000.docx', '18000000000000.docx', '1800000000000', 'a1800000000000.docx']) {
      expect(parseShadowName(n), n).toBeNull();
    }
  });
});

describe('画面の字', () => {
  it('🔴 裁定の字そのまま(押し所 2 つ)', () => {
    expect(SHADOW_OPEN_SHADOW_LABEL).toBe('一時保存した内容で開く');
    expect(SHADOW_OPEN_SAVED_LABEL).toBe('保存済みの版で開く');
  });

  it('経過は相対で言う(1 分以内 / N 分前 / N 時間前 / N 日前)。時計のずれ(未来)は 1 分以内', () => {
    const now = 1_800_000_000_000;
    expect(shadowAgo(now - 30_000, now)).toBe('1 分以内');
    expect(shadowAgo(now + 60_000, now), '未来の時刻で負の分').toBe('1 分以内');
    expect(shadowAgo(now - 60_000, now)).toBe('1 分前');
    expect(shadowAgo(now - 59 * 60_000, now)).toBe('59 分前');
    expect(shadowAgo(now - 60 * 60_000, now)).toBe('1 時間前');
    expect(shadowAgo(now - 23 * 3_600_000, now)).toBe('23 時間前');
    expect(shadowAgo(now - 24 * 3_600_000, now)).toBe('1 日前');
    expect(shadowAgo(now - 6 * 24 * 3_600_000, now)).toBe('6 日前');
  });

  it('説明: 何分前か / どちらで開いても保存するまで添付は変わらないこと / 保存済みの版で開くと編集が消えること(先に言う)', () => {
    const now = 1_800_000_000_000;
    const note = shadowDialogNote(now - 12 * 60_000, now);
    expect(note).toBe(
      '12 分前に一時保存した内容があります。どちらで開いても、保存するまで添付は変わりません。保存済みの版で開くと、その内容は消えます。',
    );
    expect(shadowDialogNote(now - 10_000, now), '1 分以内でも日本語として据わる').toBe(
      '1 分以内に一時保存した内容があります。どちらで開いても、保存するまで添付は変わりません。保存済みの版で開くと、その内容は消えます。',
    );
    expect(note.includes('\n'), '1 行').toBe(false);
  });

  it('🔴 この機能の画面の字に「控え」を使わない(マニュアルの「控え」= 入れ替える前の旧い中身 と別物を指してしまう)', () => {
    const texts = [
      SHADOW_DIALOG_TITLE,
      SHADOW_OPEN_SHADOW_LABEL,
      SHADOW_OPEN_SAVED_LABEL,
      SHADOW_OPENED_NOTICE,
      SHADOW_GONE_NOTICE,
      shadowDialogNote(0, 1_800_000_000_000),
    ];
    for (const t of texts) expect(t, `「${t}」`).not.toContain('控え');
    expect(SHADOW_DIALOG_TITLE).toBe('保存していない編集があります');
    expect(SHADOW_OPENED_NOTICE).toBe('一時保存した内容を Office で開きます。保存すると、添付の中身が入れ替わります(前の中身は残ります)');
    expect(SHADOW_GONE_NOTICE).toBe('一時保存した内容を読めませんでした。保存済みの版で開きます');
  });

  it('🔴 新しく出る字に、使わない語(造語・脅し語)を含めない', () => {
    const texts = [
      SHADOW_DIALOG_TITLE,
      SHADOW_OPEN_SHADOW_LABEL,
      SHADOW_OPEN_SAVED_LABEL,
      SHADOW_OPENED_NOTICE,
      SHADOW_GONE_NOTICE,
      shadowDialogNote(0, 1_800_000_000_000),
    ];
    for (const t of texts) {
      for (const b of BANNED_TERMS) {
        // 実在する別の語に挟まれた誤検知(画面 / 入口 …)は、ui-terms の走査と同じ正規表現(除外つき)で見る
        expect(b.pattern().test(t), `「${t}」に使わない語「${b.banned}」`).toBe(false);
      }
    }
  });
});

/**
 * 🔴 **控えと比べる相手は「添付の中身が最後に保存された時刻」**(UX レビュー 2026-10-03、PR #1320)。
 * ⚠ ノートの `updatedAt` ではない ── 題名・タグ・説明を直しただけで動き、控えの門が黙って閉じる。
 */
describe('attachmentSavedAt ── 添付の中身が最後に保存された時刻', () => {
  const body = (history: string[]) =>
    `---\nattachment.history:\n${history.map((l) => `  - "${l}"`).join('\n')}\n---\n本文\n`;
  it('🔴 attachment.history の最新の savedAt(= 最後の差し替え)を返す。並びが古い順でなくても最大を取る', () => {
    const b = body([
      '2026-10-01T00:00:00.000Z|auto|ast-a|10|',
      '2026-10-03T12:00:00.000Z|auto|ast-c|30|',
      '2026-10-02T00:00:00.000Z|pinned|ast-b|20|名前',
    ]);
    expect(attachmentSavedAt(b, '2026-09-01T00:00:00.000Z')).toBe(Date.parse('2026-10-03T12:00:00.000Z'));
  });
  it('履歴が無ければノートの作成時刻(= 添付を入れた時刻)に落とす', () => {
    expect(attachmentSavedAt('# 添付\n', '2026-09-01T00:00:00.000Z')).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
    expect(attachmentSavedAt(null, '2026-09-01T00:00:00.000Z')).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
  });
  it('どちらも無い / 読めない時刻は null(= 訊く側へ倒す)', () => {
    expect(attachmentSavedAt(null, null)).toBeNull();
    expect(attachmentSavedAt('# 添付\n', 'いつか')).toBeNull();
  });
});
