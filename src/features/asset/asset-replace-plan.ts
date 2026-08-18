/**
 * 添付の版を差し替えるときの**計画**を立てる(#88 / O4)。
 *
 * 🔴 user 裁定 2026-08-11:「**保存したら旧版と差し替えるべきです**」。
 *
 * ## ここは「何をどう書き換えるか」を決めるだけ
 *
 * disk も IDB も触らない ── **本文の一覧を渡すと、書き換えた本文の一覧と報告が返る**。
 * 実際に書くのは効果の側(`store-effects`)。⚠ こうしておかないと、この判断が
 * 「どの test からも実行されない場所」に沈む(CLAUDE.md 2026-08-08)。
 *
 * ## 🔴 取りこぼしの数え方 ── 走査そのものは使えない
 *
 * 素朴に「書き換えたあと、広い走査で旧 key を探す」とすると**必ず見つかる** ──
 * 台帳(`attachment.history`)が旧 key を**わざと**持っているからである
 * (それが bytes を生かしている)。走査は正しく拾っているのに、報告としては嘘になる。
 *
 * 🔑 だから数えるのは「**参照の形をしているのに書き換わらなかったもの**」だけ:
 * 本文を **unescape してから狭い規則を当てる**。逃がし文字入りの綴り
 * (`asset:ast\-abc`)はここで初めて見え、台帳の行(`…|auto|ast-abc|…`)は
 * `asset:` の前置きが無いので**当たらない**。
 *
 * ⚠ **pure module**。
 */
import { rewriteAssetRefs } from './asset-ref-rewrite';
import { unescapeForScan } from './asset-ref-scan';
import {
  evictVersions,
  readVersions,
  VERSIONS_KEY,
  versionsValue,
  type AttachmentVersion,
  type EvictLimits,
} from '@features/flavor/attachment-versions';
import type { FrontmatterValue } from '@features/markdown/frontmatter';

/** 1 ノートぶんの書き換え指示。⚠ 本文の全文ではなく**差し替える key** で渡す。 */
export interface PlannedEdit {
  readonly lid: string;
  /** 本文の置換(参照の書き換え)。`null` = 本文は触らない。 */
  readonly nextText: string | null;
  /** frontmatter の差し替え(添付ノート本人だけ)。 */
  readonly frontmatter: Record<string, FrontmatterValue | undefined> | null;
  /** 書き換えた参照の数(報告用)。 */
  readonly rewrote: number;
}

export interface SaveBackPlan {
  /** 中身が変わっていない = **何もしない**(保存しただけで版を積まない)。 */
  readonly unchanged: boolean;
  readonly edits: readonly PlannedEdit[];
  /**
   * 🔴 **旧 key を指したまま残った lid**。逃がし文字入りの綴りなど、狭い規則が
   * 当たらなかったもの。⚠ **0 でなければ user に件数を出す**(黙らない)。
   */
  readonly stale: readonly string[];
  /** 上限で台帳から外れた版(⚠ bytes はここでは消さない)。 */
  readonly dropped: readonly AttachmentVersion[];
  /** 上限に収まらなかった(`pinned` だけで超えている)。 */
  readonly overBudget: boolean;
}

export interface SaveBackInput {
  /** 保存した添付ノート。 */
  readonly targetLid: string;
  readonly oldKey: string;
  readonly newKey: string;
  readonly newHash: string | null;
  readonly newBytes: number;
  /**
   * 🔴 **差し替え後の綴りと中身の種類**(#214)。
   *
   * ⚠ 直す前は key / size / hash / history の 4 つしか書き戻しておらず、
   * `.odt` を `.docx` で上書き保存しても frontmatter は**古い綴りのまま**残った。
   * 読み手は 5 面(情報行 / ダウンロード名 / 参照コピー / **Office で開く** /
   * ランチャー起動)あり、とくに Office は**拡張子で filter を選ぶ**ので、
   * 古い名前で渡すと開けない文書ができる。
   * 🔑 読み手は `attachment-flavor.ts` の 1 か所に寄っているので、**ここを直せば
   *   5 面とも直る**。
   */
  readonly newName: string;
  readonly newMime: string;
  /** 旧版の大きさ(台帳に積む)。 */
  readonly oldBytes: number;
  /** ISO 8601。⚠ **呼び側が渡す**(純関数は時計を持たない)。 */
  readonly savedAt: string;
  /** 全ノートの本文(lid → body)。⚠ 添付ノート自身も含める。 */
  readonly bodies: ReadonlyMap<string, string>;
  /**
   * 🔴 **ほかの添付の台帳が既に使っているバイト**(容量上限を全体で見るため)。
   *
   * ⚠ 渡さないと上限が**この添付の中だけ**で閉じ、全体では超える
   * (2026-08-11、変異試験で判明 ── 台帳を丸ごと渡す形にしていたが、
   * 他所の版を**落とす**判断まではここに無いので、数えるだけの形へ直した)。
   * 🔑 予約分は数えるが落とさない ── 保存した添付の履歴を削るのが自然で、
   * 無関係なノートの履歴を巻き添えにしない。
   */
  readonly otherBytes?: number;
  readonly limits?: EvictLimits;
}

/** 参照の形をしているのに書き換わらなかった箇所があるか。 */
function hasMissedRef(text: string, oldKey: string): boolean {
  // ⚠ **unescape してから**狭い規則を当てる ── 逃がし文字入りはここで初めて見える。
  //    台帳の行は `asset:` の前置きが無いので当たらない(だから嘘の報告にならない)。
  const norm = unescapeForScan(unescapeForScan(text));
  return rewriteAssetRefs(norm, oldKey, `${oldKey}-probe`).count > 0;
}

/**
 * 差し替えの計画を立てる。
 *
 * ⚠ **中身が同じなら何もしない** ── 保存しただけ(編集していない)で版を積むと、
 * 上限がすぐ埋まって本当に残したい版が押し出される。
 */
export function planSaveBack(input: SaveBackInput): SaveBackPlan {
  const { targetLid, oldKey, newKey } = input;
  if (oldKey === newKey) {
    return { unchanged: true, edits: [], stale: [], dropped: [], overBudget: false };
  }

  const targetBody = input.bodies.get(targetLid) ?? '';

  // ① 台帳へ旧版を積み、上限を当てる
  const history: AttachmentVersion[] = [
    ...readVersions(targetBody),
    {
      savedAt: input.savedAt,
      kind: 'auto',
      assetKey: oldKey,
      bytes: input.oldBytes,
      label: '',
    },
  ];
  const groups = new Map<string, readonly AttachmentVersion[]>([[targetLid, history]]);
  const evicted = evictVersions(groups, {
    ...input.limits,
    reservedBytes: input.otherBytes ?? 0,
  });
  const mine = evicted.get(targetLid)!;

  // ② 本文の書き換え。⚠ 添付ノート自身の説明文にも参照が書ける
  const edits: PlannedEdit[] = [];
  const stale: string[] = [];
  for (const [lid, body] of input.bodies) {
    const r = rewriteAssetRefs(body, oldKey, newKey);
    const isTarget = lid === targetLid;
    if (hasMissedRef(r.text, oldKey)) stale.push(lid);
    if (!isTarget && r.count === 0) continue; // 触らない
    edits.push({
      lid,
      nextText: r.count > 0 ? r.text : null,
      frontmatter: isTarget
        ? {
            'attachment.asset_key': newKey,
            'attachment.size': input.newBytes,
            // 🔴 綴りと中身の種類(#214)── 5 面がここを読む
            'attachment.name': input.newName,
            'attachment.mime': input.newMime,
            // ⚠ hash が無い環境では **key を消さずに** 値だけ落とす…のではなく
            //    key ごと消す(嘘の hash を残さない)
            'attachment.hash': input.newHash ?? undefined,
            [VERSIONS_KEY]: versionsValue(mine.keep),
          }
        : null,
      rewrote: r.count,
    });
  }

  return {
    unchanged: false,
    edits,
    stale,
    dropped: mine.dropped,
    overBudget: mine.overBudget,
  };
}
