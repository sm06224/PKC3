/**
 * reducer の slice: 本文の部分書き換え(タスク / CSV / フォーム / 表 / 画像 / 色 / 添付名 / 繰り返し)(#1383)。
 *
 * 🔑 `app-state.ts` の `reduceCore` から**機械的に移した**(case 本体は 1 文字も変えていない)。
 *   `reduceCore` は label を列挙してここへ渡す ── `switch` の網羅検査は両側で効く
 *   (`reduceCore` に label が無ければ `reduceBodyEdit` に届かず、ここに case が無ければ tsc が落ちる)。
 * ⚠ 履歴・2 ペインの掃除・バックリンクは `reduceWithHistory` の 1 か所で見る(ここでは見ない)。
 */

import {
  type AppState,
  type Dispatchable,
  type ReduceResult,
  blockedWithSuffix,
  bodyWriteBlockReason,
  bodyWriteBlockResult,
} from '../app-state';

export type BodyEditAction = Extract<Dispatchable, { type: 'SET_TASK_DATE' | 'SET_TASK_REPEAT' | 'ADOPT_EXTERNAL_IMAGES' | 'SET_CSV_CELL' | 'SET_FORM_VALUES' | 'SET_FORM_ROW' | 'SET_CSV_SHAPE' | 'SET_TABLE_FORMAT' | 'SET_IMAGE_ATTRS' | 'TOGGLE_TASK' | 'SET_COLOR_CODE' | 'SET_ATTACHMENT_NAME' | 'FIX_SPEAKERS' | 'SET_TASK_RUN' | 'MATERIALIZE_REPEAT' | 'MOVE_REPEAT_OCCURRENCE' }>;

export function reduceBodyEdit(state: AppState, action: BodyEditAction): ReduceResult {
  switch (action.type) {
    /**
     * 🔴 **面から予定を動かす**(user 指示 2026-08-23「なんで双方向にする発想が
     * でねぇんだよ」)。⚠ `TOGGLE_TASK` と**同じ形** ── 書換は 1 本
     * (`REQUEST_BODY_REWRITE`)を通り、面が独自の書込経路を持たない(§7)。
     * ⚠ `date: null` は**外す**(予定から落とす。消すのではない)。
     */
    case 'SET_TASK_DATE': {
      /**
       * 🔴 **断るなら、声に出して断る**(#516)。
       *
       * ⚠ 直す前は `events: []` で**黙って捨てて**いた ── 予定の面で札を掴んで
       *   日に落とすと、**札が黙って元に戻る**(成功でも失敗でもない見た目)。
       *   ⚠ 皮肉なことに `set-entry-date` の docstring 自身が
       *   「**主の道は予定の面で掴んで落とすこと**」と書いており、
       *   #513 / #515 で塞いだのは**主の道ではない 2 つ**だった。
       * 🔑 **判定はここ 1 か所**にする(§7 ── `SET_VIEW_MODE` と同じ形)。
       *   撃つ口は `SET_ENTRY_DATE` が 4 か所・`SET_TASK_DATE` が 2 か所あり、
       *   呼び側に配ると**足すたびに取りこぼす**。
       * 🔑 動詞は **`action.date` から導ける**(null = 外す)ので、1 か所でも
       *   「外す / 付ける」を言い分けられる ── 呼び側ごとに文言を配らなくてよい。
       * ⚠ **呼び名は分ける**(行の予定 / ノートの日付)── 一括りにすると
       *   user は別のものを探す(#515 のレビューの指摘と同じ)。
       */
      // ⚠ 断りは lid で判定する(C6 / #1043)── 予定表の他の書換(繰り返しの回)と揃える
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: blockedWithSuffix(blocked, action.date === null ? '行の予定を外してください' : '行に予定を付けてください'),
          },
          events: [],
        };
      // 未知 lid は no-op(押した物が消えている ── 言うことが無い)
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'line-date',
              line: action.line,
              openLine: action.openLine,
              date: action.date,
              ...(action.time === undefined ? {} : { time: action.time }),
              // ⚠ **渡されたときだけ**載せる(渡していないのに `null` を載せると、
              //    「期間を外す」という**頼んでいない指示**になる)
              ...(action.until === undefined ? {} : { until: action.until }),
              // ⚠ 同じ向き ── 渡されたときだけ(渡していないのに `null` を載せると終わりを外してしまう)
              ...(action.timeEnd === undefined ? {} : { timeEnd: action.timeEnd }),
              ...(action.repeat === undefined ? {} : { repeat: action.repeat }),
              ...(action.allDay === undefined ? {} : { allDay: action.allDay }),
            },
          },
        ],
      };
    }
    /**
     * 🔴 **その行の繰り返しを付け替える**(#855 段 0 の 3 つ目)。
     *
     * ⚠ 断り方は上の `SET_TASK_DATE` と**同じ形**(黙って捨てない)。
     * 🔑 「日付が無い行では何もしない」は `rewriteLineDate` が持つ ── ここでは
     *   本文を読まない(右クリックのたびに worker を叩く経路を増やさない)。
     */
    case 'SET_TASK_REPEAT': {
      // ⚠ 断りは lid で判定する(C6 / #1043)── 予定表の他の書換(繰り返しの回)と揃える
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: blockedWithSuffix(blocked, action.repeat === null ? '繰り返しをやめてください' : '繰り返しにしてください'),
          },
          events: [],
        };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            /**
             * ⚠ **`date` を渡さない** ── 渡すと「日付も書き換える」意味になる。
             *   ⚠ とくに**繰り返しの回の札**は、札に焼いてある日が
             *   **その回の日**であって規則の開始日ではないので、渡すと
             *   **開始日がその回の日へずれる**(静かに予定がまるごと動く)。
             */
            rewrite: { kind: 'line-date', line: action.line, openLine: action.openLine, repeat: action.repeat },
          },
        ],
      };
    }
    /**
     * 🔴 **取り込んだ外部画像を本文へ当てる**(#264 段①)。⚠ `TOGGLE_TASK` と
     *   **同じ形** ── 書換は 1 本(`REQUEST_BODY_REWRITE`)を通る(§7)。
     * ⚠ **対応が空なら撃たない** ── 1 枚も読めなかったとき、effect の
     *   「本文が変わっているため反映できませんでした(開き直してください)」が出て、
     *   **原因と無関係な直し方**を user に指示することになる(理由は binder が言う)。
     */
    case 'ADOPT_EXTERNAL_IMAGES': {
      /**
       * 🔴 **断るなら声に出す。判定は lid で**(#1051)。⚠ 直す前は `phase !== 'ready'` で
       *   **黙って捨てて**いた ── 画像を取りに行くのは数秒かかるので、その間に
       *   同じノートの編集へ入ると、binder は「取り込みました」と言うのに
       *   **本文は 1 文字も変わらなかった**(binder も同じ門で見て、断った回は
       *   取り込めた旨を言わない)。
       */
      const blockedResult = bodyWriteBlockResult(state, action.lid, 'もう一度取り込んでください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      if (Object.keys(action.adopted).length === 0) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'adopt-images', adopted: action.adopted },
          },
        ],
      };
    }
    /**
     * 🔴 **表のセルを書き換える**(#418 段①)。⚠ `TOGGLE_TASK` と**同じ形**。
     *
     * 🔴 **断るのは lid で判定する**(C6 / #1043)。⚠ 直す前は `phase` だけを見て
     *   **編集中は全ノートを黙って捨てて**いた ── 横に留めた別ノートの升も無言の
     *   dead click になっていた。編集中のノート自身だけ、声に出して断る。
     */
    case 'SET_CSV_CELL': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `表を打ってください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'csv-cell',
              line: action.line,
              openLine: action.openLine,
              col: action.col,
              value: action.value,
            },
          },
        ],
      };
    }
    /**
     * 🔴 **入力欄の値を先頭の設定欄へ**(#1456)。⚠ `SET_CSV_CELL` と同じ形(断りは lid で判定 ── C6 / #1043)。
     */
    case 'SET_FORM_VALUES': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `入力欄に打ってください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'form-vars', values: action.values },
          },
        ],
      };
    }
    /**
     * 🔴 **入力欄の値を表の行へ書く / 足す**(#1456)。⚠ `SET_CSV_CELL` と同じ形。
     */
    case 'SET_FORM_ROW': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `表に書いてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'form-row',
              table: action.table,
              mode: action.mode,
              ...(action.row === undefined ? {} : { row: action.row }),
              ...(action.openRow === undefined ? {} : { openRow: action.openRow }),
              fields: action.fields,
              cells: action.cells,
            },
          },
        ],
      };
    }
    /**
     * 🔴 **表の行・列を足す / 消す**(#418 段①)。⚠ `SET_CSV_CELL` と同じ形。
     * ⚠ 断りも同じ(C6 / #1043、lid で判定)。
     */
    case 'SET_CSV_SHAPE': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `表を触ってください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'csv-shape',
              line: action.line,
              openLine: action.openLine,
              col: action.col,
              what: action.what,
              mode: action.mode,
            },
          },
        ],
      };
    }
    /**
     * 🔴 **表の形を変える**(#708 段②)。⚠ `SET_CSV_SHAPE` と同じ形 ── 書換は
     *   1 本(`REQUEST_BODY_REWRITE`)を通り、面が独自の書込経路を持たない(§7)。
     */
    case 'SET_TABLE_FORMAT': {
      // ⚠ 断りは lid で判定する(C6 / #1043)
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, `表の形を変えてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'table-format',
              line: action.line,
              openLine: action.openLine,
              to: action.to,
              ...(action.header === undefined ? {} : { header: action.header }),
            },
          },
        ],
      };
    }
    /** 🔴 **画像の大きさ・寄せ**(#1640 ③)。⚠ `SET_TABLE_FORMAT` と同じ形 ── 書換は 1 本を通る。 */
    case 'SET_IMAGE_ATTRS': {
      // ⚠ 断りは lid で判定する(C6 / #1043)
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, `画像の大きさを変えてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'image-attrs',
              line: action.line,
              openLine: action.openLine,
              key: action.key,
              ...(action.nth !== undefined ? { nth: action.nth } : {}),
              ...(action.w !== undefined ? { w: action.w } : {}),
              ...(action.align !== undefined ? { align: action.align } : {}),
            },
          },
        ],
      };
    }
    /**
     * ⚠ 断りは lid で判定する(C6 / #1043)── 編集中のノート自身だけ断る。
     *   他ノートのチェックは binder(`toggle-task`)が先に同じ判定を通す。
     */
    case 'TOGGLE_TASK': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `チェックしてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'task', line: action.line, openLine: action.openLine },
          },
        ],
      };
    }
    /**
     * 🔴 **本文の色コードを 1 つ書き換える**(#1224)。⚠ `TOGGLE_TASK` と**同じ形** ──
     *   断りは lid で判定する(新しい断り文を作らない。理由は `bodyWriteBlockReason` の 1 本)。
     */
    case 'SET_COLOR_CODE': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null) return { state: { ...state, error: blockedWithSuffix(blocked, `色を直してください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'color',
              line: action.line,
              nth: action.nth,
              from: action.from,
              to: action.to,
            },
          },
        ],
      };
    }
    /**
     * 🔴 **添付のファイル名を書き換える**(#1220)。⚠ `SET_COLOR_CODE` と**同じ形** ── 断りは lid で判定する。
     * ⚠ 題名は呼び手が先に `RENAME_ENTRY_TITLE` で撃つ(題名の門は別 ── 編集中でも通る)。
     *   断りの文は他の本文の書換と同じ 1 本(`bodyWriteBlockResult`)。
     */
    case 'SET_ATTACHMENT_NAME': {
      const blockedResult = bodyWriteBlockResult(state, action.lid, 'ファイル名を変えてください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'attachment-name', typed: action.name },
          },
        ],
      };
    }
    /**
     * 🔴 **話者を直す**(#952 B6)。⚠ `SET_ATTACHMENT_NAME` と**同じ形** ── 断りは lid で判定する。
     *   名前の付け替えと「## 話者つき文字起こし」の作り直しは、効果層が本文を読んでから `applyBodyRewrite` で行う。
     */
    case 'FIX_SPEAKERS': {
      const blockedResult = bodyWriteBlockResult(state, action.lid, '話者を直してください');
      if (blockedResult !== null) return blockedResult;
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'speakers-fix', renames: action.renames, at: action.at },
          },
        ],
      };
    }
    /**
     * 🔴 **リストを丸ごとそろえる**(#1173)。⚠ `TOGGLE_TASK` と**同じ形** ── 断りは lid で判定する。
     *   繰り返しの行を飛ばした数の知らせは、効果層が本文を読んだ後に言う
     *   (reducer は本文を持たない)。
     */
    case 'SET_TASK_RUN': {
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return {
          state: {
            ...state,
            error: blockedWithSuffix(blocked, action.to === 'done' ? '完了にしてください' : '未完了に戻してください'),
          },
          events: [],
        };
      const meta = state.entryMetas.get(action.lid);
      if (!meta || action.lines.length === 0) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'task-run', lines: action.lines, openLines: action.openLines, to: action.to },
          },
        ],
      };
    }
    /**
     * 🔴 **繰り返しの回を済ませる**(#344 段②)。⚠ `TOGGLE_TASK` と**同じ形** ──
     *   書換は 1 本(`REQUEST_BODY_REWRITE`)を通る(§7)。何をするかの判断は
     *   `body-rewrite.ts` が持ち、ここは**単位を選ぶだけ**である。
     */
    case 'MATERIALIZE_REPEAT': {
      // ⚠ 断りは lid で判定する(C6 / #1043)
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, `その日の分を済ませてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: { kind: 'repeat-done', line: action.line, openLine: action.openLine, date: action.date },
          },
        ],
      };
    }
    /**
     * 🔴 **繰り返しの「その回だけ」を動かす**(#855 決4)。
     * ⚠ すぐ上と**同じ形** ── 書換は 1 本(`REQUEST_BODY_REWRITE`)を通り、
     *   何をするかの判断は `body-rewrite.ts` が持つ。
     */
    case 'MOVE_REPEAT_OCCURRENCE': {
      // ⚠ 断りは lid で判定する(C6 / #1043)
      const blocked = bodyWriteBlockReason(state, action.lid);
      if (blocked !== null)
        return { state: { ...state, error: blockedWithSuffix(blocked, `繰り返しの回を動かしてください`) }, events: [] };
      const meta = state.entryMetas.get(action.lid);
      if (!meta) return { state, events: [] };
      return {
        state,
        events: [
          {
            type: 'REQUEST_BODY_REWRITE',
            lid: meta.lid,
            title: meta.title,
            archetype: meta.archetype,
            entryOrder: meta.entryOrder,
            rewrite: {
              kind: 'repeat-move',
              line: action.line,
              openLine: action.openLine,
              from: action.from,
              to: action.to,
              ...(action.time === undefined ? {} : { time: action.time }),
              ...(action.timeEnd === undefined ? {} : { timeEnd: action.timeEnd }),
            },
          },
        ],
      };
    }
  }
}
