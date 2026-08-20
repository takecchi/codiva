import { Box, type DOMElement, type Key } from 'ink';
import { type FC, type RefObject, useRef } from 'react';
import {
  bufferOf,
  COMPOSER_PREFIX_CELLS,
  caretIndexAtClick,
  composerRowCount,
  emptyBuffer,
  INPUT_MAX_ROWS,
  type MouseEvent,
  type SelectionRange,
  type TextBuffer,
} from '@/core';
import {
  useAbsolutePosition,
  useBoxHeight,
  useComposerWidth,
  useDragSelection,
  useTextBufferRef,
} from './hooks';
import { editText, resolveEnter } from './input';
import { PromptInput } from './prompt-input';

/**
 * 入力欄（コンポーザ）は 4 か所にある — 一覧の新規指示、詳細の追加指示、`/prompt` の
 * エディタ、質問ダイアログの「自分で入力する」。かつては各所が `useTextBufferRef` +
 * `useDragSelection` + `caretIndexAtClick` + `editText` を**それぞれ**組み立てていたため、
 * 場所によって Shift+Enter が効かない / ↑↓ が動かない / ドラッグでコピーできない、と
 * 仕様が食い違っていた。ここはその組み立てを 1 か所に畳んだもので、**一覧のコンポーザの
 * 仕様が唯一の基準**になる:
 *
 *  - Enter は `resolveEnter`（Shift/Meta+Enter と末尾バックスラッシュで改行、他は送信）
 *  - ←→ でキャレット移動、↑↓ は**折り返し後の表示行**で移動（`wrapWidth`）
 *  - Ctrl+U で全消し、ペースト等の制御文字はサニタイズ（`editText`）
 *  - 幅いっぱいで折り返し（truncate しない）、`maxRows` を超えたら内部スクロール
 *  - ドラッグで範囲選択 → 離した時点で 1 回だけクリップボードへコピー
 *  - クリックでキャレット移動（IME 用の実カーソルは `PromptInput` が置く）
 *
 * 「1画面 1 `useInput`」は崩さない: ここは `useInput` を持たず、view の単一ハンドラから
 * `handleMouse` / `handleKey` を呼んでもらう（consumed かどうかを戻り値で返す）。
 */
export interface ComposerOptions {
  /** 初期バッファ（`/prompt` のエディタは既存の内容で開く）。省略すると空。 */
  initial?: TextBuffer;
  /** 範囲選択のコピー先（OSC 52）。合成ルートから注入される。 */
  onCopy?: (text: string) => void;
  /** 内部スクロールに切り替わるまでの表示行数。既定は `INPUT_MAX_ROWS`。 */
  maxRows?: number;
}

/**
 * `handleKey` の結果。`submit` は Enter が確定（改行ではない）だったことを表し、
 * テキストは trim 済み。`handled` はこの入力欄が消費した（改行・編集・キャレット移動）、
 * `ignored` は何もしなかった（呼び出し側が自分のキー操作として扱ってよい）。
 */
export type ComposerKeyResult =
  | { kind: 'submit'; text: string }
  | { kind: 'handled' }
  | { kind: 'ignored' };

export interface ComposerKeyOptions {
  /**
   * ↑↓ をキャレット移動に使うか（既定 true）。詳細ビューのログスクロールや一覧の入力
   * 履歴のように、view 側が先に ↑↓ を取るケースは view 側で分岐してからここへ渡す。
   */
  vertical?: boolean;
}

export interface ComposerController {
  /** 描画用のバッファ（state）。 */
  buffer: TextBuffer;
  /** 最新のバッファ（ref）。同一 tick に複数イベントが届いても stale にならない。 */
  bufferRef: RefObject<TextBuffer>;
  /** バッファを差し替える（ref → state の順で反映）。 */
  setBuffer: (next: TextBuffer) => void;
  /** 空にする（送信後など）。 */
  reset: () => void;
  /** `Composer` に渡す計測用 ref（折り返し幅・位置・高さの実測に使う）。 */
  boxRef: RefObject<DOMElement | null>;
  /** 内部スクロールに切り替わるまでの表示行数（描画と当たり判定で同じ値を使う）。 */
  maxRows: number;
  /** 実測した折り返し幅（未計測なら undefined = 折り返さない）。 */
  wrapWidth: number | undefined;
  /**
   * この入力欄が実際に描く行数（内部スクロールの窓 + 上下の罫線）。当たり判定の
   * 「縦に潰れていないか」検算に使うほか、**入力欄を内側に持つダイアログ**が自分の
   * 縦幅を見積るのに使う（`ui/permission-dialog.tsx` の選択肢ブロックの予算）。
   */
  drawnRows: number;
  /** 現在のハイライト範囲（ドラッグ選択）。 */
  selection: SelectionRange | undefined;
  /** ドラッグ中か（press と release のあいだ）。 */
  dragging: () => boolean;
  /** ハイライトを消す（キー入力・フォーカス移動時）。 */
  clearSelection: () => void;
  /** マウス座標 → キャレット index。欄の外・幾何が信用できないときは undefined。 */
  caretAt: (x: number, y: number) => number | undefined;
  /**
   * press / drag / release をこの入力欄として処理する。**この欄が扱ったら true** を返すので、
   * 呼び出し側はそこで打ち切る（false なら自分の当たり判定へ落とす）。`wheel` は扱わない。
   */
  handleMouse: (mouse: MouseEvent) => boolean;
  /** キー入力を処理する（Enter の解決 → 編集）。 */
  handleKey: (input: string, key: Key, opts?: ComposerKeyOptions) => ComposerKeyResult;
}

/**
 * 入力欄の状態と振る舞い（キー・マウス）をまとめたコントローラ。描画は {@link Composer}
 * に渡す。`useInput` はここには置かない（1画面 1 useInput は view が持つ）。
 */
export function useComposer(opts: ComposerOptions = {}): ComposerController {
  const { initial, onCopy, maxRows = INPUT_MAX_ROWS } = opts;
  const { buffer, bufferRef, updateBuffer } = useTextBufferRef(initial);
  const boxRef = useRef<DOMElement>(null);
  // 折り返し幅・左上位置・高さはすべて**同じ Box**を測る。描画（PromptInput）と当たり
  // 判定が同じ幾何を通ることがクリック位置の正しさの前提（ink-components.md）。
  const wrapWidth = useComposerWidth(boxRef);
  const box = useAbsolutePosition(boxRef);
  const height = useBoxHeight(boxRef);
  const sel = useDragSelection(onCopy);
  // 押した位置（キャレットを置く候補）。ドラッグにならずに離したときだけ使う。
  const pressedRef = useRef<number | undefined>(undefined);
  // 最後にドラッグで拾った位置。press と違えばドラッグ、同じなら単なるクリック。
  const focusedRef = useRef<number | undefined>(undefined);

  /**
   * 保留中の press を捨てる。**キー入力が挟まったら必ず呼ぶ**（`clearSelection` 経由）:
   * 押したまま何か打って離すと、release が「単なるクリック」と判定してキャレットを
   * press した位置へ引き戻し、打った文字の後ろにいたキャレットが飛ぶ。質問ダイアログの
   * ように press と release のあいだでモード（＝この欄の表示有無）が変わる画面では、
   * 消し忘れた index が次の release まで生き残って古い位置を指す。
   */
  const clearPress = () => {
    pressedRef.current = undefined;
    focusedRef.current = undefined;
  };

  // 実際に描かれる行数（内部スクロールの窓 + 上下の罫線）。実測高さがこれより小さい =
  // 縦に潰れて行が抜けている状態なので、当たり判定そのものをやめる（黙って別の行の
  // 文字を選ぶより選べないほうがよい。ヘッダと同じ方針）。
  const drawnRows = Math.min(composerRowCount(buffer.value, wrapWidth), maxRows) + 2;

  const caretAt = (x: number, y: number): number | undefined => {
    if (!box || (height !== undefined && height < drawnRows)) {
      return undefined;
    }
    // `+ 1` は上の罫線を飛ばす。prefix ぶん引くと x が本文内の表示桁になる。
    return caretIndexAtClick(
      bufferRef.current,
      y - (box.top + 1),
      x - box.left - COMPOSER_PREFIX_CELLS,
      maxRows,
      wrapWidth,
    );
  };

  const handleMouse = (mouse: MouseEvent): boolean => {
    if (mouse.kind === 'press') {
      const index = caretAt(mouse.x, mouse.y);
      pressedRef.current = index;
      focusedRef.current = index;
      if (index === undefined) {
        // 欄の外を押した = この選択は捨てる（呼び出し側が自分の当たり判定へ進む）。
        sel.clear();
        return false;
      }
      sel.begin(index);
      return true;
    }
    if (mouse.kind === 'drag') {
      if (!sel.dragging()) {
        return false;
      }
      const index = caretAt(mouse.x, mouse.y);
      if (index !== undefined) {
        focusedRef.current = index;
        sel.extend(index);
      }
      return true;
    }
    if (mouse.kind === 'release') {
      const anchored = sel.dragging();
      sel.end(bufferRef.current.value);
      // **選択中はキャレットを動かさない。** 表示ウィンドウ（`visibleLineRange`）は
      // キャレット行から決まるので、press / drag の時点で動かすと `maxRows` を超える
      // 内容では画面がその場でスクロールし、描かれている行と当たり判定が食い違って
      // 「触っていない行」がコピーされる。キャレットを置くのはドラッグにならずに
      // 離したとき（= 単なるクリック）だけにする。
      const pressed = pressedRef.current;
      if (pressed !== undefined && focusedRef.current === pressed) {
        updateBuffer(bufferOf(bufferRef.current.value, pressed));
      }
      clearPress();
      return anchored;
    }
    return false;
  };

  const handleKey = (input: string, key: Key, keyOpts: ComposerKeyOptions = {}) => {
    const { vertical = true } = keyOpts;
    if (key.return) {
      const enter = resolveEnter(bufferRef.current, key);
      if (enter.kind === 'newline') {
        updateBuffer(enter.buffer);
        return { kind: 'handled' } as const;
      }
      return { kind: 'submit', text: enter.text } as const;
    }
    // ↑↓ は折り返し後の**表示行**で動かす（wrapWidth）。論理行だと長い1行の途中から
    // 一気に先頭へ飛び、見えている行と操作が食い違う。
    const edit = editText(bufferRef.current, input, key, { arrows: true, vertical, wrapWidth });
    if (edit.changed) {
      updateBuffer(edit.buffer);
      return { kind: 'handled' } as const;
    }
    return { kind: 'ignored' } as const;
  };

  return {
    buffer,
    bufferRef,
    setBuffer: updateBuffer,
    reset: () => {
      clearPress();
      updateBuffer(emptyBuffer());
    },
    boxRef,
    maxRows,
    wrapWidth,
    drawnRows,
    selection: sel.selection,
    dragging: sel.dragging,
    clearSelection: () => {
      clearPress();
      sel.clear();
    },
    caretAt,
    handleMouse,
    handleKey,
  };
}

/**
 * 入力欄の描画。計測用の Box は**`PromptInput` だけ**を包む — コマンドパレットのような
 * 付随表示まで同じ Box に入れると、実測した `top` が入力欄の上端とズレてクリックが
 * 別の文字に当たる。付随表示は呼び出し側でこの外に置く。
 *
 * `flexShrink={0}` は必須。Yoga は溢れた子を「クリップ」せず「縮小」するので、付けないと
 * 低い端末で複数行を書いているあいだ入力欄が潰れ、`caretAt` の「実測高さ < 描いた行数なら
 * 当たり判定をやめる」ガードが常時成立してクリックが効かない死角になる。縮む役は
 * flexGrow + 内部スクロールを持つ領域（一覧・ログ）に寄せる。
 */
export const Composer: FC<{
  composer: ComposerController;
  focused: boolean;
  placeholder?: string;
}> = ({ composer, focused, placeholder }) => (
  <Box ref={composer.boxRef} flexDirection="column" flexShrink={0}>
    <PromptInput
      buffer={composer.buffer}
      focused={focused}
      placeholder={placeholder}
      maxRows={composer.maxRows}
      selection={composer.selection}
    />
  </Box>
);
