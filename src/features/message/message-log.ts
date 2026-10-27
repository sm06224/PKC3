/**
 * 🔴 **メッセージ型**(設計 doc `docs/development/ui-total-design-2026-09.md` §7、段②a)。
 *
 * メッセージは **system 領域のノート 1 件**(フレーバー = ログ)。裁定 2026-09-20
 * 「システム用ノートで GO。user のディレクトリと明確に分けることが条件」を、
 * ノートという既存の型(`entries.realm = 'system'`)に載せて実現する ──
 * 新しい画面も新しい保存の仕組みも作らない。
 *
 * 🔴 **中身を漏らさない**(§7)。書く口を 1 つ(`postMessage`、adapter 側)に絞り、
 * ここでは**固定の形の節しか作れない** ── user の題名・見出し・添付名を
 * 組み込める自由な文字列を、そのまま本文へ書き込む経路を構造から無くす。
 *
 * ⚠ **pure module**(browser API を持たない)。IndexedDB の控え・localStorage の
 * 既読は adapter 側(`src/adapter/platform/message-post.ts`)が持つ。
 */
import { formatHeadingTimestamp } from '../flavor/textlog-flavor';

export type MessageKind = 'result' | 'caution' | 'problem' | 'delivery' | 'job';

/** 画面の字(設計 doc §7 の表)。 */
export const MESSAGE_KIND_LABEL: Readonly<Record<MessageKind, string>> = {
  result: '結果',
  caution: '注意',
  problem: '問題',
  delivery: '配信',
  job: '処理',
};

/**
 * 逆引き(節の先頭に書いた太字の字から種類を読み直す ── `countUnread` が使う)。
 * ⚠ **`MESSAGE_KIND_LABEL` の写しを手で書かない**(§7「同じ値は複数の場所に
 * 置かない」)── ここから組む。
 */
const LABEL_TO_KIND: ReadonlyMap<string, MessageKind> = new Map(
  (Object.keys(MESSAGE_KIND_LABEL) as MessageKind[]).map((k) => [MESSAGE_KIND_LABEL[k], k]),
);

/**
 * 🔴 **system 領域の固定 lid**(設計 doc §7)。
 *
 * ⚠ **種類ごとに分けるのは上限が違うから**(§7)── `result / caution / problem /
 *   delivery` は 1 本のノート(題名「メッセージ」)に集約し、`job`
 *   (ワーカーの記録。段②b で接続)だけ上限が違う(5,000 件)ので別ノートにする。
 *   ⚠ 画面では「メッセージ」の節 1 つに種類の切替として見せる(§7)。
 */
export const SYSTEM_MESSAGE_LID = 'sys-messages';
export const SYSTEM_JOB_LID = 'sys-jobs';

/** その種類のメッセージを書くノートの lid。 */
export function lidForMessageKind(kind: MessageKind): string {
  return kind === 'job' ? SYSTEM_JOB_LID : SYSTEM_MESSAGE_LID;
}

/**
 * 🔴 **system のメッセージ 2 lid かどうかの判定は、ここ 1 か所を通す**
 * (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 *
 * ⚠ **`entries.realm` を読まない**(段②a の時点では system 領域のノートは
 *   この 2 件しか無いので、固定の lid 判定で足りる)。system 領域のノートの
 *   種類が増えたら、ここを `realm` ベースの判定へ寄せ直すこと(段③以降)。
 */
export function isSystemMessageLid(lid: string): boolean {
  return lid === SYSTEM_MESSAGE_LID || lid === SYSTEM_JOB_LID;
}

/** そのノートの題名(設計 doc §7)。 */
export function titleForMessageLid(lid: string): string {
  return lid === SYSTEM_JOB_LID ? '処理の記録' : 'メッセージ';
}

/**
 * 🔴 **上限**(設計 doc §7)。
 * ⚠ user が選べるのは `result / caution / problem / delivery` の側だけ
 * (`MESSAGE_CAP_OPTIONS`)。`job` は既定で固定(§7「処理 = 5,000 件保管」)。
 */
export const MESSAGE_CAP_DEFAULT = 500;
export const MESSAGE_CAP_OPTIONS: readonly number[] = [100, 500, 2000];

/**
 * 🔴 **保存された上限の読み方は 1 つ**(#1087)。⚠ 端末の読み手(`currentMessageCap`)と設定ファイルの下見
 *   (`PORTABLE_KEYS` の検査)が**同じ関数**を通る ── 別々に書くと、下見は「入ります」と言うのに読み手は
 *   既定へ丸める、がまた起きる。選べる値でなければ `null`。
 */
export function parseMessageCap(raw: string | null): number | null {
  const n = raw === null ? NaN : Number(raw);
  return MESSAGE_CAP_OPTIONS.includes(n) ? n : null;
}
export const JOB_CAP = 5000;

/** そのノートに効く上限(`job` は configuredCap を無視する)。 */
export function capForMessageLid(lid: string, configuredCap: number): number {
  return lid === SYSTEM_JOB_LID ? JOB_CAP : configuredCap;
}

/** 1 件の節に必要な物。⚠ `text` は呼び側が `sanitizeMessageText` を通した後の値。 */
export interface MessageSectionInput {
  /** ISO timestamp。 */
  readonly at: string;
  readonly kind: MessageKind;
  /** 出所(固定の機能名。user の入力は含めない)。 */
  readonly source: string;
  /** 文(サニタイズ済み)。 */
  readonly text: string;
}

/**
 * 🔴 **出所の画面の字**(内部の名前を英語のまま見せない)。
 * `app` / `status` は「どこから」を言う意味が無いので空(出所を書かない)。
 * ⚠ 表に無い名前(ワーカーの記録の lane 名・「貼り付け」など既に日本語のもの)はそのまま。
 */
export const MESSAGE_SOURCE_LABEL: Readonly<Record<string, string>> = {
  app: '',
  status: '',
  quota: '保存領域の空き',
  storage: '保存先',
  notice: 'お知らせ',
  schedule: '予定',
  draft: '保存していない編集',
  'portable-boot': 'PKC3 入り HTML の起動',
  'office-profile': 'Office',
  'db-rescue-rebuild': 'ノートの保存データの作り直し',
  'db-rescue-reset': 'ノートの保存データの初期化',
  'storage-vacuum': '保存領域を縮める',
  'storage-optimize': '索引の整理',
  'asset-gc': '添付の整理',
  'force-release': '書き込みの強制終了',
  // 🔴 ワーカーの記録の lane 名(#1087 M7)── 内部の名前を英語のまま見せない
  math: '数式',
  chart: 'グラフ',
  plotly: 'グラフ(plotly)',
  asr: '文字起こし',
  voice: '声の仕上げ',
  asset: '添付',
  wave: '波形',
  audio: '音声',
  ooxml: 'Office の書き出し',
  markdown: 'Markdown の表示',
  video: '動画',
  textlab: 'テキスト整形の置換',
};

export function messageSourceLabel(source: string): string {
  return Object.prototype.hasOwnProperty.call(MESSAGE_SOURCE_LABEL, source)
    ? (MESSAGE_SOURCE_LABEL[source] as string)
    : source;
}

/**
 * 1 件の節を組む。
 *
 * ⚠ **見出しは `textlog-flavor.ts` と同じ形**(`## YYYY-MM-DD HH:mm:ss`)を使う ──
 *   普通のノートと同じ道具(検索・別窓・印刷・書き出す)でそのまま読めるように、
 *   記法を 1 つも増やさない(設計 doc §7「新しい画面も道具も作らない」)。
 * ⚠ **`text` はここでは sanitize しない** ── 呼び側(`postMessage`)が
 *   `sanitizeMessageText` を通した後の値を渡す(判断を 1 か所に置く)。
 */
export function formatMessageSection(input: MessageSectionInput): string {
  const heading = `## ${formatHeadingTimestamp(input.at)}`;
  const label = MESSAGE_KIND_LABEL[input.kind];
  const source = messageSourceLabel(input.source);
  // 出所が無い(`app` / `status`)ときは「種類 文」だけ ── 英語の内部名を画面に出さない
  return source === '' ? `${heading}\n**${label}** ${input.text}\n\n` : `${heading}\n**${label}** ${source}: ${input.text}\n\n`;
}

/**
 * 🔴 **中身を漏らさない**(設計 doc §7)。
 *
 * ① 「…」『…』の中身を潰す ── 題名・見出し・添付名が混ざる形は、この repo では
 *    全部この括弧で書かれる(13 か所の実例)。
 * ② 改行を空白へ ── 節の形(見出し + 1〜2 行)を壊さない。
 * ③ 80 字で切る ── 生の例外(`${e.message}` / `${String(e)}`)は無制限の長さを
 *    持ちうる。⚠ **切ったことは字で言う**(黙って切らない ── CLAUDE.md §1)。
 */
/**
 * 🔴 **括弧の潰しは入れ子を数えて閉じる**(#1087)── 名前が `」` / `「` を含むと、最初の `」` で閉じると後半が残る
 *   (「【重要】「A社との契約」について」→「について」)。目印(`markName`)を当てていない口(「${…}」の形は
 *   260 か所を超える)も、これで後半を残さない。
 * - 開きと閉じを数え、深さが 0 に戻った所で 1 つの名前とする(入れ子の 」 は名前の中)。
 * - 深さ 0 で現れた余りの閉じは、直前の名前の続きとみなす(名前に 」 が 1 つだけ入った形:「a」b」)。
 * - 閉じずに終わったら末尾まで潰す(中身を出さない側に倒す)。
 * ⚠ 2 つの名前の間の字(「A」から「B」へ の「から」)は、つなぎの語だけなら残す(それ以外は下の M6 で 1 つに潰す)。
 */
/** 2 つの名前の間に在ってよい、つなぎの語(これ以外が挟まったら 1 つの名前の中とみなす)。 */
const CONNECTOR_GAP_RE = /^\s*(?:から|まで|より|と|を|へ|に|の|が|は|で|や|→|⇒|、|・|\/|,)?\s*$/;
function collapseBrackets(text: string, open: string, close: string): string {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === close) {
      if (depth > 0) {
        depth--;
        if (depth === 0) spans.push([start, i]);
      } else if (spans.length > 0) {
        spans[spans.length - 1]![1] = i;
      }
    }
  }
  if (depth > 0) spans.push([start, text.length - 1]);
  /**
   * 🔴 **名前が `」` と `「` を両方含む形は、間の字も名前の続き**(#1087 M6)。⚠ 「${t}」を…」の t が
   *   `a」秘密「b` だと、括弧は釣り合って 2 つの名前に見え、間の「秘密」が残った。外から見て
   *   「2 つの名前の間の字」と「名前の中の字」は区別できない ── 間が**つなぎの語だけ**(`CONNECTOR_GAP_RE`)なら
   *   2 つの名前とみなして間を残し(「A」から「B」へ)、それ以外は中身を出さない側に倒して 1 つに潰す。
   * ⚠ 残る漏れ:名前が `a」から「b` のようにつなぎの語そのものを挟む形は、そのつなぎの語(1〜2 字)だけが残る。
   */
  for (let i = spans.length - 1; i > 0; i--) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    if (!CONNECTOR_GAP_RE.test(text.slice(prev[1] + 1, cur[0]))) {
      prev[1] = cur[1];
      spans.splice(i, 1);
    }
  }
  let out = '';
  let at = 0;
  for (const [a, b] of spans) {
    out += text.slice(at, a) + open + '…' + close;
    at = b + 1;
  }
  return out + text.slice(at);
}

/**
 * 🔴 **名前の目印**(#1087)。題名・添付名が `」` を含むと、括弧の字だけでは
 * 後半が残る(「【重要】「A社との契約」について」→「について」が漏れる)。括弧の字では中身の終わりが決まらないので、
 * 名前の前後に**目に見えない字**を付け、`sanitizeMessageText` は目印の間を中身に関係なく潰す。
 * ⚠ 目印は表示から外さない(U+2060 / U+2061 は幅の無い字で、画面の見た目は変わらない ── 外す口を
 *   画面の字の全経路に置くより、残して無害にするほうが漏れない)。
 * ⚠ 名前の中に目印の字が在っても終わりが早まらないよう、`markName` が名前から目印を取り除く。
 */
const NAME_OPEN = '\u2060';
const NAME_CLOSE = '\u2061';
const MARKED_NAME_RE = /\u2060[^\u2061]*(?:\u2061|$)/g;
export function markName(name: string): string {
  return `${NAME_OPEN}${name.replace(/[\u2060\u2061]/g, '')}${NAME_CLOSE}`;
}
const MAX_MESSAGE_TEXT_LENGTH = 80;

/**
 * 🔴 **改行の類は全部空白へ**(#1087)。⚠ `splitSections` の `^` は `\n` だけでなく `\r` / U+2028 / U+2029 の
 *   直後にも当たる(`m` フラグ)── `\r?\n` だけを畳むと、単独の `\r` や U+2028 の後ろに `## ` を置いた字で節が割れた。
 */
const LINE_BREAKS_RE = /\r\n|[\r\n\u2028\u2029]/g;

export function sanitizeMessageText(text: string, fixedHead = ''): string {
  /**
   * 🔴 **アプリが書いた固定の文は、そのまま通す**(#1087)。⚠ 括弧で潰すと、案内に出てくるボタンの名前
   * (「容量の内訳」など ── user のデータではない)が「…」になり、80 字で切ると「次にすること」が落ちる。
   * 先頭が `fixedHead` と一致するときだけ、その部分を通し、残り(生の例外の字など)は今までどおり潰して切る。
   */
  if (fixedHead !== '' && text.startsWith(fixedHead)) {
    const rest = text.slice(fixedHead.length);
    return fixedHead.replace(LINE_BREAKS_RE, ' ') + (rest === '' ? '' : sanitizeMessageText(rest));
  }
  const unmarked = text.replace(MARKED_NAME_RE, '…');
  const collapsed = collapseBrackets(collapseBrackets(unmarked, '「', '」'), '『', '』');
  const flattened = collapsed.replace(LINE_BREAKS_RE, ' ');
  // 🔴 字数は**コードポイント**で数えて切る(#1087 M10)。⚠ `slice` は UTF-16 の単位で切るので、
  //   絵文字などの代用対の途中で切れて、保存で U+FFFD になった。
  const points = Array.from(flattened);
  return points.length > MAX_MESSAGE_TEXT_LENGTH
    ? `${points.slice(0, MAX_MESSAGE_TEXT_LENGTH).join('')}…`
    : flattened;
}

/**
 * 節ごとに分ける。⚠ **`## ` から始まる行の直前で切る** ── `appendMessage` が
 * 足すのは `formatMessageSection` の出力だけなので、本文は必ず `## ` から始まる
 * (先頭の空文字列は捨てる)。
 */
function splitSections(body: string): string[] {
  if (body === '') return [];
  return body.split(/(?=^## )/m).filter((s) => s !== '');
}

/**
 * 古い節から落として上限に収める(設計 doc §7「種類ごと・古い節から落とす」)。
 * ⚠ **節の単位で切る** ── 途中で切ると壊れた markdown を残す。
 */
export function trimToCap(body: string, cap: number, slack = 0): string {
  const sections = splitSections(body);
  if (sections.length <= cap) return body;
  // 🔴 上限を超えたときは**余裕の分まで多めに落とす**(#1087 M8)。⚠ ちょうど上限で切ると、満杯の後は
  //   追記のたびに古い 1 件を落として本文全体を書き直す(5000 件で約 440KB)。余裕を持てば、落とすのは
  //   `slack` 件に 1 回で済む。
  //   ⚠ 余裕を持たせるのは処理の記録(5,000 件)だけ ── メッセージは画面に出す保管件数どおりに保つ
  //   (台帳 #1852 束 L1。依頼 267)ので、呼び側が `slack = 0` を渡す。
  const keep = Math.max(1, cap - Math.max(0, Math.min(slack, cap - 1)));
  let drop = sections.length - keep;
  /**
   * 🔴 **落とす順は「結果などの日常の知らせ → 注意・問題」**(台帳 #1852 束 L1。依頼 343 / 117-1 / 92-2)。
   *   「コピーしました」のような結果が続くと、バグの報告に要る注意・問題が先に押し出されていた。
   *   各グループの中は古い順。⚠ 注意・問題だけで上限を超えたときは、その古い順から落とす(青天井にしない)。
   */
  const dropped = new Set<number>();
  for (const protectedPass of [false, true]) {
    for (let i = 0; i < sections.length && drop > 0; i++) {
      if (dropped.has(i)) continue;
      const m = SECTION_HEAD_RE.exec(sections[i] ?? '');
      const kind = m ? LABEL_TO_KIND.get(m[2] ?? '') : undefined;
      const isProtected = kind === 'caution' || kind === 'problem';
      if (isProtected !== protectedPass) continue;
      dropped.add(i);
      drop -= 1;
    }
  }
  return sections.filter((_, i) => !dropped.has(i)).join('');
}

/**
 * 🔴 **その種類の知らせだけを残した本文**(台帳 #1852 束 L1。依頼 266)── メッセージのノートを読む画面の絞り込み用。
 * ⚠ 画面に出す物を絞るだけ(disk の本文も書き出しも変えない)。`kind === null` は絞らない(1 バイトも変えない)。
 * ⚠ 該当が 0 件のときは、空の画面にせず 1 行で言う。
 */
export function filterMessageBody(body: string, kind: MessageKind | null): string {
  if (kind === null) return body;
  const kept = splitSections(body).filter((s) => {
    const m = SECTION_HEAD_RE.exec(s);
    return m !== null && LABEL_TO_KIND.get(m[2] ?? '') === kind;
  });
  return kept.length === 0 ? `(「${MESSAGE_KIND_LABEL[kind]}」の知らせはありません)\n` : kept.join('');
}

/** 上限を超えたとき、上限よりどれだけ少なく残すか(上限の 5 分の 1 まで、最大 200 件)。 */
export function messageTrimSlack(cap: number): number {
  return Math.min(200, Math.floor(cap / 5));
}

/**
 * 🔴 **余裕を持たせるのは処理の記録だけ**(台帳 #1852 束 L1。依頼 267)。
 * 「保管件数 100 件」と出しているメッセージは、101 件目で 80 件まで減っていた ── 画面の数どおり(超えた分だけ)に保つ。
 * 処理の記録は 5,000 件で本文が大きい(追記のたびの書き直しが約 440KB)ので、「5,000 件まで」の範囲で多めに落とす。
 */
export function trimSlackForLid(lid: string, cap: number): number {
  return lid === SYSTEM_JOB_LID ? messageTrimSlack(cap) : 0;
}

/**
 * 🔴 **未読の数**(設計 doc §7「既読」)。
 *
 * ⚠ 数えるのは **注意 / 問題だけ** ── 結果・配信・処理は「読んで確かめる」
 *   性質の知らせではないので未読に数えない(起動のたびに未読が増え続けない)。
 * ⚠ `readAtIso === null`(まだ 1 度も開いていない)なら、注意 / 問題は全部未読。
 */
const SECTION_HEAD_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\n\*\*([^*]+)\*\*/;

export function countUnread(body: string, readAtIso: string | null): number {
  const readMark = readAtIso === null ? '' : formatHeadingTimestamp(readAtIso);
  let count = 0;
  for (const section of splitSections(body)) {
    const m = SECTION_HEAD_RE.exec(section);
    if (!m) continue;
    const at = m[1] ?? '';
    const kind = LABEL_TO_KIND.get(m[2] ?? '');
    if (kind !== 'caution' && kind !== 'problem') continue;
    if (at > readMark) count += 1;
  }
  return count;
}

/**
 * 🔴 **控えの節をノートの本文の後ろへ足す**(#1087 M1)。⚠ 節は `formatMessageSection` が組んだ後の字で、
 *   ここでは**何も整形し直さない**(普通の節と同じ形のまま並ぶ)。控えは作られた順に渡す。
 */
export function withSpooledSections(dbBody: string, spooled: readonly string[]): string {
  return dbBody + spooled.join('');
}

/**
 * 🔴 **既読の直後に積む節の時刻**(#1087 M5)。⚠ 見出しは**秒まで**なので、既読の時刻と同じ秒に積んだ
 *   注意は `at > readMark` で数えられず、数え直すと未読から落ちた。既読の秒と同じか前に当たるなら、
 *   既読の次の秒へ送る(< 1 秒のずれ。順番は崩れない)。
 * ⚠ 既読が未来(時計のずれ)なら送らない ── 遠い未来の見出しを書かない。
 */
export function postedAtAfterReadMark(nowIso: string, readAtIso: string | null): string {
  if (readAtIso === null) return nowIso;
  const now = Date.parse(nowIso);
  const mark = Date.parse(readAtIso);
  if (Number.isNaN(now) || Number.isNaN(mark) || mark > now + 2000) return nowIso;
  if (formatHeadingTimestamp(nowIso) > formatHeadingTimestamp(readAtIso)) return nowIso;
  return new Date(Math.floor(mark / 1000) * 1000 + 1000).toISOString();
}
