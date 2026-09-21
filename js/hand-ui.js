// 手札レイアウト編集コンポーネント。Firebase 非依存、DOM のみ。
//
// layout = ['か1', '_', 'き2', ...]  ('_' = スペース)
//
// 操作(editable のとき):
//   - カードをタップ → 選択(もう一度タップで解除)。onSelect(cardId|null) を通知
//   - 選択中に隙間(スロット)をタップ → そこへ移動
//   - 選択なしで隙間をタップ → スペースを挿入
//   - スペースをタップ → そのスペースを削除
//   - カードをドラッグ → 最寄りの隙間へ移動(Pointer Events、タッチ対応)
//   - ドロップゾーン(setDropZone で指定した外部の DOM 要素)へカードをドラッグ →
//     並べ替えではなく onDropToZone(cardId) を通知(捨てる操作などに使う)
//   - undo() で直前の並びに戻す(最大 10 手)
//
// 使い方:
//   const editor = HandUI.createHandEditor(el, { layout, editable: true, onChange, onSelect, onDropToZone, onDragOverZone });
//   editor.setLayout(newLayout, { drawn: 'か1' });  // サーバーからの更新を反映
//   editor.setDropZone(zoneEl);  // 毎レンダー呼び直してよい。null で無効化
//
// 生成する DOM(CSS は style.css の .hand / .card / .slot を参照):
//   <div class="hand">
//     <button class="slot" data-index="0"></button>
//     <button class="card" data-id="か1">か</button>
//     <button class="slot" data-index="1"></button>
//     <button class="space" data-index="1"></button>
//     ...
//     <button class="slot" data-index="N"></button>
//   </div>

(function (global) {
  const SPACE = '_';
  const DRAG_THRESHOLD = 8; // px。これ未満の移動はタップ扱い
  const MAX_UNDO = 10;

  function defaultCharOf(id) {
    return global.Cards ? global.Cards.charOf(id) : id.replace(/\d+$/, '');
  }

  function createHandEditor(container, options) {
    const opts = Object.assign(
      { layout: [], editable: true, charOf: defaultCharOf, onChange: null, onSelect: null, size: 'lg' },
      options || {}
    );

    let layout = opts.layout.slice();
    let editable = !!opts.editable;
    let selectedId = null;
    let drawnId = null;
    let highlightIds = []; // 外部から強調したいカード(ポン選択など)
    let dropZone = opts.dropZone || null; // 捨てる、など「並べ替え以外」のドラッグ先
    let pendingExternal = null; // ドラッグ中に来た setLayout を保留し、ドロップ後に反映する
    const undoStack = [];

    function sameCardSet(a, b) {
      const ca = a.filter((t) => t !== SPACE).slice().sort();
      const cb = b.filter((t) => t !== SPACE).slice().sort();
      return ca.length === cb.length && ca.every((v, i) => v === cb[i]);
    }

    container.classList.add('hand');
    container.dataset.size = opts.size;

    // ---- 描画 --------------------------------------------------------------
    function render() {
      const prevLefts = captureCardLefts();
      container.innerHTML = '';
      container.classList.toggle('hand--editable', editable);
      container.classList.toggle('hand--selecting', !!selectedId);
      if (editable) container.appendChild(makeSlot(0));
      layout.forEach((token, i) => {
        if (token === SPACE) {
          container.appendChild(makeSpace(i));
        } else {
          container.appendChild(makeCard(token));
        }
        if (editable) container.appendChild(makeSlot(i + 1));
      });
      playFlip(prevLefts);
    }

    // ---- 入れ替えの簡易アニメーション(FLIP)----------------------------------
    // 描画し直す前に各カードの位置を覚えておき、描画後に「元の位置にいたふり」をしてから
    // 本来の位置へ滑らせる。同じ id のカードが動いた場合だけ効果が出る。
    function captureCardLefts() {
      const map = {};
      container.querySelectorAll('.card').forEach((el) => {
        map[el.dataset.id] = el.getBoundingClientRect().left;
      });
      return map;
    }

    function playFlip(prevLefts) {
      container.querySelectorAll('.card').forEach((el) => {
        const prevLeft = prevLefts[el.dataset.id];
        if (prevLeft == null) return; // 新しく増えたカード(ツモなど)はアニメーションしない
        const dx = prevLeft - el.getBoundingClientRect().left;
        if (Math.abs(dx) < 1) return; // 動いていない
        el.style.transition = 'none';
        el.style.transform = 'translateX(' + dx + 'px)';
        void el.offsetWidth; // 強制リフローしてから戻す(FLIP テクニック)
        let cleared = false;
        const clear = () => {
          if (cleared) return;
          cleared = true;
          el.style.transition = '';
          el.style.transform = '';
        };
        requestAnimationFrame(() => requestAnimationFrame(clear));
        setTimeout(clear, 50); // rAF が来ない環境(バックグラウンドタブ等)でも必ず戻す保険
      });
    }

    function makeCard(id) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'card';
      el.dataset.id = id;
      el.textContent = opts.charOf(id);
      el.setAttribute('aria-label', opts.charOf(id));
      if (id === selectedId) el.classList.add('card--selected');
      if (id === drawnId) el.classList.add('card--drawn');
      if (highlightIds.indexOf(id) >= 0) el.classList.add('card--highlight');
      if (editable) {
        el.addEventListener('pointerdown', onCardPointerDown);
      } else {
        el.tabIndex = -1;
      }
      return el;
    }

    function makeSpace(index) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'space';
      el.dataset.index = String(index);
      el.setAttribute('aria-label', 'スペース(タップで削除)');
      if (editable) {
        el.addEventListener('click', () => {
          pushUndo();
          layout = layout.slice(0, index).concat(layout.slice(index + 1));
          commit();
        });
      } else {
        el.tabIndex = -1;
      }
      return el;
    }

    function makeSlot(index) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'slot';
      el.dataset.index = String(index);
      el.setAttribute('aria-label', selectedId ? 'ここに移動' : 'スペースを入れる');
      el.addEventListener('click', () => {
        if (selectedId) {
          moveCard(selectedId, index);
        } else {
          pushUndo();
          layout = layout.slice(0, index).concat([SPACE], layout.slice(index));
          commit();
        }
      });
      return el;
    }

    // ---- 状態変更 ----------------------------------------------------------
    function pushUndo() {
      undoStack.push(layout.slice());
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function commit() {
      render();
      if (opts.onChange) opts.onChange(layout.slice());
    }

    // cardId を「現在の並びにおける index の位置」へ移動(index は削除前の位置基準)。
    // 選択解除もここで一緒に行い、描画が1回で済むようにする(2回に分けると
    // 入れ替えアニメーション用の位置比較が正しく効かないため)。
    function moveCard(cardId, index) {
      const from = layout.indexOf(cardId);
      if (from < 0) return;
      let to = index;
      if (to > from) to -= 1;
      selectedId = null;
      if (to === from) { render(); if (opts.onSelect) opts.onSelect(null); return; }
      pushUndo();
      const next = layout.slice(0, from).concat(layout.slice(from + 1));
      next.splice(to, 0, cardId);
      layout = next;
      commit();
      if (opts.onSelect) opts.onSelect(null);
    }

    function setSelected(id) {
      selectedId = id;
      render();
      if (opts.onSelect) opts.onSelect(selectedId);
    }

    // ---- ドラッグ ----------------------------------------------------------
    let drag = null; // { id, startX, startY, ghost, active, slots: [{el, x, y}], target }

    function onCardPointerDown(e) {
      if (!editable || e.button !== 0 && e.pointerType === 'mouse') return;
      const id = e.currentTarget.dataset.id;
      drag = { id, startX: e.clientX, startY: e.clientY, ghost: null, active: false, slots: [], target: null, el: e.currentTarget };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* 合成イベント等 */ }
      e.currentTarget.addEventListener('pointermove', onCardPointerMove);
      e.currentTarget.addEventListener('pointerup', onCardPointerUp);
      e.currentTarget.addEventListener('pointercancel', onCardPointerUp);
    }

    function onCardPointerMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        // 縦方向が優勢ならページスクロールの意図とみなしてドラッグを始めない
        // (タッチでは touch-action: pan-y によりブラウザ側で pointercancel になる。マウス用の保険)
        if (Math.abs(dy) > Math.abs(dx) * 1.5) { abortDrag(e); return; }
        startDrag(e);
      }
      drag.ghost.style.transform = 'translate(' + (e.clientX - drag.gx) + 'px,' + (e.clientY - drag.gy) + 'px)';
      const overZone = isOverZone(e.clientX, e.clientY);
      if (overZone !== drag.overZone) {
        drag.overZone = overZone;
        drag.ghost.classList.toggle('card--ghost-drop', overZone);
        if (opts.onDragOverZone) opts.onDragOverZone(overZone);
      }
      if (overZone) {
        // ゾーン上にいる間は並べ替え先のハイライトを消す(移動先ではなく別の操作先だと示す)
        if (drag.target) { drag.target.el.classList.remove('slot--over'); drag.target = null; }
      } else {
        updateDropTarget(e.clientX, e.clientY);
      }
    }

    function abortDrag(e) {
      const el = drag.el;
      el.removeEventListener('pointermove', onCardPointerMove);
      el.removeEventListener('pointerup', onCardPointerUp);
      el.removeEventListener('pointercancel', onCardPointerUp);
      try { el.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      drag = null;
    }

    function isOverZone(x, y) {
      if (!drag.zoneRect) return false;
      return x >= drag.zoneRect.left && x <= drag.zoneRect.right && y >= drag.zoneRect.top && y <= drag.zoneRect.bottom;
    }

    function startDrag(e) {
      drag.active = true;
      const rect = drag.el.getBoundingClientRect();
      const ghost = drag.el.cloneNode(true);
      ghost.classList.add('card--ghost');
      ghost.style.position = 'fixed';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      ghost.style.pointerEvents = 'none';
      ghost.style.zIndex = '1000';
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.gx = e.clientX;
      drag.gy = e.clientY;
      drag.overZone = false;
      drag.zoneRect = dropZone ? dropZone.getBoundingClientRect() : null;
      drag.el.classList.add('card--dragging');
      container.classList.add('hand--dragging');
      drag.slots = Array.from(container.querySelectorAll('.slot')).map((el) => {
        const r = el.getBoundingClientRect();
        return { el, x: r.left + r.width / 2, y: r.top + r.height / 2, index: Number(el.dataset.index) };
      });
    }

    function updateDropTarget(x, y) {
      let best = null;
      let bestD = Infinity;
      for (const s of drag.slots) {
        // 行(y)を優先し、同じ行の中で x が近いスロットを選ぶ
        const d = Math.abs(s.y - y) * 3 + Math.abs(s.x - x);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (drag.target && drag.target !== best) drag.target.el.classList.remove('slot--over');
      if (best) best.el.classList.add('slot--over');
      drag.target = best;
    }

    function onCardPointerUp(e) {
      if (!drag) return;
      const el = drag.el;
      el.removeEventListener('pointermove', onCardPointerMove);
      el.removeEventListener('pointerup', onCardPointerUp);
      el.removeEventListener('pointercancel', onCardPointerUp);
      try { el.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
      const d = drag;
      drag = null;
      if (!d.active) {
        // タップ扱い: 選択のトグル
        if (e.type !== 'pointercancel') setSelected(selectedId === d.id ? null : d.id);
        return;
      }
      if (d.ghost) d.ghost.remove();
      el.classList.remove('card--dragging');
      container.classList.remove('hand--dragging');
      if (d.target) d.target.el.classList.remove('slot--over');
      if (opts.onDragOverZone) opts.onDragOverZone(false);
      // ドラッグ中に外から来ていた更新(カード集合が変わった等)があれば、ドロップ操作より優先して反映する
      if (pendingExternal) {
        const ext = pendingExternal;
        pendingExternal = null;
        api.setLayout(ext.next, ext.extra);
        if (e.type !== 'pointercancel' && d.overZone && opts.onDropToZone && layout.indexOf(d.id) >= 0) {
          opts.onDropToZone(d.id);
        }
        return;
      }
      if (e.type !== 'pointercancel' && d.overZone && opts.onDropToZone) {
        selectedId = null;
        render();
        if (opts.onSelect) opts.onSelect(null);
        opts.onDropToZone(d.id);
      } else if (e.type !== 'pointercancel' && d.target) {
        moveCard(d.id, d.target.index);
      } else {
        render();
      }
    }

    // ---- 公開 API ----------------------------------------------------------
    const api = {
      // サーバー等からの更新を反映。選択中カードが消えていれば選択解除。
      // カードの集合が変わった(ツモ・捨て・ポン・新しい局)ときは「もどす」の履歴を捨てる。
      // 捨てた札や前の局の札が画面に復活してしまうのを防ぐため。
      setLayout(next, extra) {
        const ex = extra || {};
        if (drag && drag.active) { pendingExternal = { next: next.slice(), extra: ex }; return; }
        if (!sameCardSet(layout, next)) undoStack.length = 0;
        layout = next.slice();
        if (typeof ex.drawn !== 'undefined') drawnId = ex.drawn;
        if (typeof ex.highlight !== 'undefined') highlightIds = ex.highlight || [];
        if (selectedId && layout.indexOf(selectedId) < 0) {
          selectedId = null;
          if (opts.onSelect) opts.onSelect(null);
        }
        render();
      },
      getLayout() { return layout.slice(); },
      getSelected() { return selectedId; },
      select(id) { setSelected(id); },
      clearSelection() { if (selectedId) setSelected(null); },
      setEditable(flag) { editable = !!flag; if (!editable) selectedId = null; render(); },
      setHighlight(ids) { highlightIds = ids || []; render(); },
      setDropZone(zoneEl) { dropZone = zoneEl || null; },
      canUndo() { return undoStack.length > 0; },
      undo() {
        if (!undoStack.length) return false;
        const prev = undoStack.pop();
        if (!sameCardSet(prev, layout)) { undoStack.length = 0; render(); return false; } // 集合が違う履歴は捨てる
        layout = prev;
        selectedId = null;
        render();
        if (opts.onChange) opts.onChange(layout.slice());
        if (opts.onSelect) opts.onSelect(null);
        return true;
      },
      // スペースを全部消して詰める
      clearSpaces() {
        if (layout.indexOf(SPACE) < 0) return;
        pushUndo();
        layout = layout.filter((t) => t !== SPACE);
        commit();
      },
      destroy() { container.innerHTML = ''; container.classList.remove('hand'); },
    };

    render();
    return api;
  }

  // 読み取り専用の小さな手札(他プレイヤー用)。カードを伏せる場合は count を渡す。
  function renderReadonlyHand(container, layout, options) {
    const o = Object.assign({ charOf: defaultCharOf, hidden: false, count: 0, size: 'sm' }, options || {});
    container.innerHTML = '';
    container.classList.add('hand');
    container.dataset.size = o.size;
    if (o.hidden) {
      for (let i = 0; i < o.count; i++) {
        const el = document.createElement('span');
        el.className = 'card card--back';
        container.appendChild(el);
      }
      return;
    }
    layout.forEach((token) => {
      const el = document.createElement('span');
      if (token === SPACE) {
        el.className = 'space';
      } else {
        el.className = 'card';
        el.textContent = o.charOf(token);
      }
      container.appendChild(el);
    });
  }

  const HandUI = { SPACE, createHandEditor, renderReadonlyHand };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HandUI;
  } else {
    global.HandUI = HandUI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
