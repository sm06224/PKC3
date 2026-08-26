/**
 * 🔴 **整理案(プラン)を読む**(#429 段②)。
 *
 * 段① が書き出した構成を AI に渡すと、`mv` / `mkdir` / `rename` の列が返ってくる。
 * ここはそれを**読んで検める**だけの純関数である ── 実際に動かすのは段③。
 *
 * ## ⚠ 書き方の正本は `STRUCTURE_HELP`(段①)である
 *
 * 🔴 **書き出す側と読む側で綴りがずれると、AI は言われたとおりに書いたのに
 *   「そんな命令はありません」と断られる** ── しかも user には
 *   **どちらが間違っているのか分からない**(CLAUDE.md §7 の両端の型)。
 * 🔑 だから `tests/features/structure-plan.test.ts` が
 *   **`STRUCTURE_HELP` に書いてある綴りをそのまま読ませて**突き合わせる。
 *
 * ## 🔴 誤りは「行番号つきで、全部」返す
 *
 * ⚠ 1 件目で止めない ── 止めると user は**直しては貼り直す**を繰り返す。
 * ⚠ そして**誤りが 1 行でもあれば適用させない**(段③)── 半分だけ適用されると、
 *   どこまで進んだのか user にも分からなくなる。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import type { EntryMeta } from '@core/model/entry-meta';

/** 作る / 移す / 改名する、の 3 つ。 */
export type PlanOp =
  | { readonly kind: 'mkdir'; readonly title: string; readonly parent: PlanTarget; readonly alias: string | null }
  | { readonly kind: 'mv'; readonly lid: string; readonly parent: PlanTarget }
  | { readonly kind: 'rename'; readonly lid: string; readonly title: string };

/**
 * 親の指し方は 3 通り ── `root` / いま在るノートの `lid` / 同じ案で作る `@名前`。
 * ⚠ **`@名前` はこの案の中でしか意味を持たない**(前方参照)。
 */
export type PlanTarget =
  | { readonly at: 'root' }
  | { readonly at: 'lid'; readonly lid: string }
  | { readonly at: 'alias'; readonly alias: string };

export interface PlanError {
  /** 1 始まり。⚠ **user が見る行番号**なので 0 始まりにしない。 */
  readonly line: number;
  readonly message: string;
}

export interface Plan {
  readonly ops: readonly PlanOp[];
  readonly errors: readonly PlanError[];
}

/** 上限。⚠ 1 案でこれ以上は受けない(貼り間違いを一括適用しない)。 */
export const PLAN_MAX_OPS = 500;

/**
 * `"..."` で囲まれた題名を 1 つ取り出す。
 * ⚠ **囲みを必須にする** ── 空白を含む題名(「議事録 2026」)が普通に在るので、
 *   囲みを緩めると**どこまでが題名か決まらない**。
 */
function quoted(rest: string): { value: string; after: string } | null {
  const t = rest.trimStart();
  if (!t.startsWith('"')) return null;
  const end = t.indexOf('"', 1);
  if (end < 0) return null;
  return { value: t.slice(1, end), after: t.slice(end + 1) };
}

/** 親の指定を読む。⚠ 空なら `root`(`STRUCTURE_HELP` の「親を省くと root」)。 */
function target(word: string | undefined): PlanTarget | null {
  if (word === undefined || word === '') return { at: 'root' };
  if (word === 'root') return { at: 'root' };
  if (word.startsWith('@')) {
    const alias = word.slice(1);
    return alias === '' ? null : { at: 'alias', alias };
  }
  return { at: 'lid', lid: word };
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter((w) => w !== '');

/**
 * プランを読む。
 *
 * @param known いま在るノート(`lid` を検めるため)。⚠ **渡さないと存在しない
 *   lid を素通りさせる** ── 適用の途中で初めて落ちるのがいちばん困る。
 */
export function parsePlan(text: string, known: ReadonlyMap<string, EntryMeta>): Plan {
  const ops: PlanOp[] = [];
  const errors: PlanError[] = [];
  /** この案で作る名前。⚠ **後の行から参照できる**(前方参照)。 */
  const aliases = new Set<string>();
  const lines = text.split('\n');

  lines.forEach((raw, i) => {
    const line = i + 1;
    const body = raw.trim();
    // ⚠ 読み飛ばしの規則は `STRUCTURE_HELP` の字と同じ(# と空行)
    if (body === '' || body.startsWith('#')) return;
    if (ops.length >= PLAN_MAX_OPS) {
      if (errors.every((e) => e.message !== TOO_MANY)) errors.push({ line, message: TOO_MANY });
      return;
    }
    const head = body.split(/\s+/)[0]!;
    const rest = body.slice(head.length);

    if (head === 'mkdir') {
      const q = quoted(rest);
      if (q === null) {
        errors.push({ line, message: 'mkdir は題名を " " で囲んでください' });
        return;
      }
      if (q.value.trim() === '') {
        errors.push({ line, message: 'mkdir の題名が空です' });
        return;
      }
      const tail = words(q.after);
      /**
       * ⚠ `as @名前` は**末尾に付く**。`[<親>] [as @名前]` の順なので、
       *   `as` を見つけたらそこから後ろは別名である。
       */
      const asAt = tail.indexOf('as');
      const parentWord = (asAt < 0 ? tail : tail.slice(0, asAt))[0];
      const parent = target(parentWord);
      if (parent === null) {
        errors.push({ line, message: '親の @名前 が空です' });
        return;
      }
      let alias: string | null = null;
      if (asAt >= 0) {
        const a = tail[asAt + 1];
        if (a === undefined || !a.startsWith('@') || a === '@') {
          errors.push({ line, message: 'as の後は @名前 の形で書いてください' });
          return;
        }
        alias = a.slice(1);
        if (aliases.has(alias)) {
          errors.push({ line, message: `@${alias} は既に使われています` });
          return;
        }
      }
      if (!checkParent(parent, known, aliases, line, errors)) return;
      if (alias !== null) aliases.add(alias);
      ops.push({ kind: 'mkdir', title: q.value, parent, alias });
      return;
    }

    if (head === 'mv') {
      const w = words(rest);
      if (w.length === 0) {
        errors.push({ line, message: 'mv は「mv <lid> <行き先>」の形で書いてください' });
        return;
      }
      const lid = w[0]!;
      if (!known.has(lid)) {
        errors.push({ line, message: `${lid} というノートはありません` });
        return;
      }
      const parent = target(w[1]);
      if (parent === null) {
        errors.push({ line, message: '行き先の @名前 が空です' });
        return;
      }
      if (parent.at === 'lid' && parent.lid === lid) {
        // ⚠ 自分の中へは入れられない(適用してから気づかせない)
        errors.push({ line, message: '自分自身の中へは移せません' });
        return;
      }
      if (!checkParent(parent, known, aliases, line, errors)) return;
      ops.push({ kind: 'mv', lid, parent });
      return;
    }

    if (head === 'rename') {
      const w = words(rest);
      const lid = w[0];
      if (lid === undefined) {
        errors.push({ line, message: 'rename は「rename <lid> "<新しい題名>"」の形で書いてください' });
        return;
      }
      if (!known.has(lid)) {
        errors.push({ line, message: `${lid} というノートはありません` });
        return;
      }
      const q = quoted(rest.slice(rest.indexOf(lid) + lid.length));
      if (q === null) {
        errors.push({ line, message: 'rename は新しい題名を " " で囲んでください' });
        return;
      }
      if (q.value.trim() === '') {
        errors.push({ line, message: 'rename の題名が空です' });
        return;
      }
      ops.push({ kind: 'rename', lid, title: q.value });
      return;
    }

    /**
     * ⚠ **知らない語は「読み飛ばす」ではなく「誤り」**にする ── 読み飛ばすと、
     *   AI が綴りを間違えた行が**黙って消えて**、user は「一部だけ適用された」と
     *   受け取る(何が起きなかったのか画面のどこにも出ない)。
     */
    errors.push({ line, message: `${head} は知らない命令です(mv / mkdir / rename)` });
  });

  return { ops, errors };
}

const TOO_MANY = `1 つの案で扱えるのは ${PLAN_MAX_OPS} 行までです`;

/**
 * 親が実在するか。
 * ⚠ **`@名前` は「その行より前で作られた」ものだけ**を認める ── 後ろで作る名前を
 *   先に参照できてしまうと、適用の順番が決まらない。
 */
function checkParent(
  parent: PlanTarget,
  known: ReadonlyMap<string, EntryMeta>,
  aliases: ReadonlySet<string>,
  line: number,
  errors: PlanError[],
): boolean {
  if (parent.at === 'alias' && !aliases.has(parent.alias)) {
    errors.push({
      line,
      message: `@${parent.alias} は、この行より前で作られていません`,
    });
    return false;
  }
  if (parent.at === 'lid' && !known.has(parent.lid)) {
    errors.push({ line, message: `${parent.lid} というノートはありません` });
    return false;
  }
  return true;
}

/** 下見の 1 行。⚠ 画面が字を組み直さないよう、ここで完成させる。 */
export interface PlanPreviewLine {
  /** `mkdir` / `mv` / `rename`。⚠ 印を変えたいだけの側が字を作らない。 */
  readonly kind: PlanOp['kind'];
  readonly text: string;
}

/**
 * 🔴 **適用したら何が起きるか**(#429 段③)。
 *
 * ⚠ **lid を並べない** ── user は `mta73ihn-0001` を読めない。
 *   **題名で**「どれが、どこへ」を書く(内部語を user に見せない、の規約)。
 * ⚠ 案の中で作るフォルダは**まだ lid が無い**ので、`@名前` は
 *   **その行で作る題名**に読み替える ── 読み替えないと
 *   「@arc へ移します」という、user には意味の無い字になる。
 */
export function planPreview(
  ops: readonly PlanOp[],
  metas: ReadonlyMap<string, EntryMeta>,
): PlanPreviewLine[] {
  /** この案で作るフォルダの題名(`@名前` → 題名)。 */
  const madeHere = new Map<string, string>();
  const titleOf = (lid: string): string => metas.get(lid)?.title ?? lid;
  const where = (t: PlanTarget): string => {
    if (t.at === 'root') return 'いちばん上';
    if (t.at === 'lid') return `「${titleOf(t.lid)}」の中`;
    // ⚠ 未知の別名はここへ来ない(`parsePlan` が前方参照を検めている)
    return `「${madeHere.get(t.alias) ?? t.alias}」の中`;
  };
  return ops.map((op) => {
    if (op.kind === 'mkdir') {
      if (op.alias !== null) madeHere.set(op.alias, op.title);
      return { kind: op.kind, text: `${where(op.parent)}に、フォルダ「${op.title}」を作ります` };
    }
    if (op.kind === 'mv') {
      return { kind: op.kind, text: `「${titleOf(op.lid)}」を ${where(op.parent)}へ移します` };
    }
    return { kind: op.kind, text: `「${titleOf(op.lid)}」の題名を「${op.title}」に変えます` };
  });
}

/**
 * 🔴 **適用してよいか**(#429 段③)。
 *
 * ⚠ **誤りが 1 行でもあれば押せない** ── 半分だけ適用されると、どこまで進んだのか
 *   user にも分からなくなる(そして戻す道が無い)。
 * ⚠ **何も無い案も押せない** ── 押しても何も起きないボタンを出さない。
 */
export const canApplyPlan = (plan: Plan): boolean =>
  plan.errors.length === 0 && plan.ops.length > 0;

/**
 * 🔴 **親の指定を、実際の lid へ解く**(#429 段③)。
 *
 * ⚠ 適用のループがこれを自前で書くと、下見(`planPreview`)と**別の答え**を出しうる
 *   ── 「見た通りに動かない」はいちばん user の信用を失う形である(§7)。
 * 🔑 だから**解き方はここ 1 か所**。下見も適用も同じ `made` の育て方をする。
 *
 * @param made この案で作ったフォルダ(`@名前` → いま作った lid)
 * @returns 親の lid。⚠ `null` は **root**(「親なし」ではなく「いちばん上」)
 */
export function resolvePlanTarget(
  target: PlanTarget,
  made: ReadonlyMap<string, string>,
): string | null {
  if (target.at === 'root') return null;
  if (target.at === 'lid') return target.lid;
  /**
   * ⚠ **未知の別名はここへ来ない**(`parsePlan` が前方参照を検めている)。
   * ⚠ それでも `?? null` にする ── 来てしまったら **root へ落とす**ほうが、
   *   `undefined` を親として撃って**関係が壊れる**より安全である。
   */
  return made.get(target.alias) ?? null;
}
