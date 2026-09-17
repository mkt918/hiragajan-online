// アプリ本体: Firebase 接続・部屋の作成/参加・リアルタイム購読・トランザクション・画面描画。
//
// 同期の設計(Phase A で確定。Phase B ではこの仕組みに乗って画面を作り込む):
//   - rooms/{code} 1ドキュメントに全状態(GameLogic の room 形)を置き、onSnapshot で購読する
//   - ゲームの操作はすべて runAction('関数名', ...args) 経由。
//     runTransaction 内で doc を読み → GameLogic[関数名](room, uid, ...args) → 結果を書き戻す
//   - 自分の手札の並び(layout)だけはトランザクションを使わず、400ms デバウンスで
//     round.hands.{uid}.layout をフィールド更新する(他人は自分の layout に触らない)
//   - 操作前に必ず flushLayout() で未送信の並びを送る(送らないと古い並びで上書きされる)
//
// Phase B の拡張ポイント:
//   - renderBanner()   … ガイドバナーの文言/色
//   - renderOthers()   … 他プレイヤー欄(手札の伏せ表示・河・meld)
//   - renderActions()  … 主操作ボタン(ツモ/捨てる/あがり/ポン/ロン/パス)
//   - renderModal()    … あがり宣言モーダル・結果画面
//   - ロビー/待機画面の見た目は index.html + style.css 側

(function () {
  const L = window.GameLogic;
  const C = window.Cards;

  let auth, db;
  let uid = null; // 現在の「自分」の識別子。オンライン中は realUid、練習モード中は 'you'
  let realUid = null; // Firebase 匿名認証の本物の uid(練習モードから戻すときに使う)
  let roomCode = null;
  let room = null; // 最新の rooms/{code} ドキュメント、または練習モードのローカル room
  let unsubscribeRoom = null;
  let handEditor = null;
  let selectedCardId = null; // 手札で選択中のカード(捨てる候補)
  let ponPick = null; // ポン用に選んだ手札 [id, id] / null = ポン選択中ではない
  let claimTimer = null;
  let practiceMode = false; // 練習モード(Firebase を使わずローカルで CPU と対戦)
  let cpuTimer = null;

  // レイアウトのデバウンス送信
  let pendingLayout = null;
  let layoutTimer = null;
  const LAYOUT_DEBOUNCE_MS = 400;

  const el = (id) => document.getElementById(id);
  const roomRef = () => db.collection('rooms').doc(roomCode);

  // ---------------------------------------------------------------------------
  // Firebase 初期化・匿名認証
  // ---------------------------------------------------------------------------
  function initFirebase() {
    try {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db = firebase.firestore();
    } catch (e) {
      el('connection-status').textContent = 'Firebase初期化エラー: js/firebase-config.js を設定してください。';
      console.error(e);
      return;
    }
    auth.signInAnonymously().catch((err) => {
      el('connection-status').textContent = 'ログインエラー: ' + err.message;
      console.error(err);
    });
    auth.onAuthStateChanged((user) => {
      if (!user) return;
      realUid = user.uid;
      if (!practiceMode) uid = realUid;
      el('connection-status').textContent = '接続完了。部屋をつくるか、部屋コードを入れてね。';
      el('create-room-btn').disabled = false;
      el('join-room-btn').disabled = false;
      checkUrlForRoom();
    });
  }

  function checkUrlForRoom() {
    const code = new URLSearchParams(window.location.search).get('room');
    if (code && /^\d{4}$/.test(code)) {
      el('room-code-input').value = code;
      joinRoom(code);
    }
  }

  function myName() {
    const v = el('name-input').value.trim();
    const name = v || 'プレイヤー';
    try { localStorage.setItem('hiragajan:name', name); } catch (_) { /* noop */ }
    return name;
  }

  // ---------------------------------------------------------------------------
  // 部屋の作成・参加・退室
  // ---------------------------------------------------------------------------
  function generateRoomCode() {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  }

  async function createRoom() {
    el('lobby-error').textContent = '';
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const openHands = el('open-hands-input').checked;
    const claimSeconds = Number(el('claim-seconds-input').value);
    const name = myName();
    try {
      // 衝突したら別コードで再試行
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateRoomCode();
        const ref = db.collection('rooms').doc(code);
        const created = await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref);
          if (doc.exists) return false;
          const base = L.createRoom({ uid, name, mode, openHands, claimSeconds, now: Date.now() });
          tx.set(ref, Object.assign(base, {
            code,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }));
          return true;
        });
        if (created) { enterRoom(code); return; }
      }
      throw new Error('部屋コードの空きが見つかりませんでした。もう一度試してください。');
    } catch (e) {
      el('lobby-error').textContent = '部屋の作成に失敗しました: ' + e.message;
      console.error(e);
    }
  }

  async function joinRoom(code) {
    el('lobby-error').textContent = '';
    if (!/^\d{4}$/.test(code)) { el('lobby-error').textContent = '4けたの部屋コードを入れてね。'; return; }
    const name = myName();
    const ref = db.collection('rooms').doc(code);
    try {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error('その部屋はありません。');
        const res = L.joinRoom(doc.data(), uid, name, Date.now());
        if (res.error) throw new Error(res.error);
        tx.update(ref, {
          players: res.room.players,
          order: res.room.order,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      enterRoom(code);
    } catch (e) {
      el('lobby-error').textContent = e.message;
      console.error(e);
    }
  }

  function enterRoom(code) {
    roomCode = code;
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.history.replaceState({}, '', url);
    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = roomRef().onSnapshot((doc) => {
      if (!doc.exists) { toast('部屋が消えました'); leaveRoom(); return; }
      room = doc.data();
      render();
    }, (err) => {
      console.error(err);
      toast('接続エラー: ' + err.message);
    });
  }

  async function leaveRoom() {
    if (practiceMode) {
      practiceMode = false;
      clearTimeout(cpuTimer);
      cpuTimer = null;
      uid = realUid; // 本物の Firebase uid に戻す
      room = null;
      roomCode = null;
      selectedCardId = null;
      ponPick = null;
      showScreen('lobby');
      return;
    }
    // ロビー中なら参加者リストからも抜ける。ゲーム中は購読解除のみ(再入室できる)
    if (room && room.status === 'lobby' && L.isPlayer(room, uid)) {
      try { await runAction('leaveRoom'); } catch (_) { /* noop */ }
    }
    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = null;
    roomCode = null;
    room = null;
    pendingLayout = null;
    clearTimeout(layoutTimer);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
    showScreen('lobby');
  }

  // ---------------------------------------------------------------------------
  // 練習モード: Firebase を使わず、ブラウザの中だけで CPU と対戦する。
  // 動作確認用(2台目の端末なしで一通りの流れを試せる)。
  // ---------------------------------------------------------------------------
  function startPractice() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const openHands = el('open-hands-input').checked;
    const claimSeconds = Number(el('claim-seconds-input').value);
    const cpuCount = Number(el('cpu-count-input').value) || 1;
    const name = myName() || 'あなた';

    uid = 'you';
    practiceMode = true;
    roomCode = null;

    let r = L.createRoom({ uid, name, mode, openHands, claimSeconds, now: Date.now() });
    for (let i = 1; i <= cpuCount; i++) {
      r = must(L.joinRoom(r, 'cpu' + i, 'CPU' + i, Date.now()));
    }
    r = must(L.startGame(r, uid, {}));
    room = r;
    render();

    function must(res) {
      if (res.error) { console.error('practice setup failed:', res.error); throw new Error(res.error); }
      return res.room;
    }
  }

  // CPU の「あがり」判断確率。
  // 注意: 配布枚数+1=あがり枚数(基本7→8、上級13→14)という設計上、
  // ツモ直後・ポン直後は「枚数だけ」なら毎回あがり宣言できてしまう(役の妥当性は判定しない設計のため)。
  // 100%の確率で宣言すると CPU が毎ターン即あがってしまい、ポンや長い局を検証できないので、
  // わざと低い確率に抑えて「たまに勝負がつく」程度にしている。
  const CPU_TSUMO_CHANCE = 0.12;
  const CPU_RON_CHANCE = 0.15;
  const CPU_PON_CHANCE = 0.3;

  // CPU の1手を room に直接適用する(Firebase を経由しない)
  function applyLocal(fnName, actingUid, ...args) {
    const fn = L[fnName];
    const res = fn(room, actingUid, ...args, { now: Date.now() });
    if (res.error) {
      console.warn('practice:' + fnName, actingUid, res.error);
      return false;
    }
    room = res.room;
    render();
    return true;
  }

  // 今 CPU がすることがあれば少し間を置いて cpuTick を呼ぶ。無ければ何もしない
  // (renderGame の末尾から毎回呼ばれ、人間の番になったら自然に止まる)
  function scheduleCpu() {
    clearTimeout(cpuTimer);
    cpuTimer = null;
    if (!practiceMode || !room || !room.round) return;
    const r = room.round;
    let needsBot = false;
    if (r.phase === 'declare') needsBot = r.declaration.uid !== uid;
    else if (r.phase === 'claim') needsBot = true; // 何もすることがなければ cpuTick が無視する
    else if (r.phase === 'draw' || r.phase === 'discard') needsBot = L.currentUid(room) !== uid;
    if (needsBot) cpuTimer = setTimeout(cpuTick, 700);
  }

  function cpuTick() {
    if (!practiceMode || !room || !room.round) return;
    const r = room.round;
    if (r.phase === 'declare') {
      if (r.declaration.uid !== uid) applyLocal('confirmWin', r.declaration.uid);
      return;
    }
    if (r.phase === 'claim') {
      if (cpuActClaim()) return;
      if (L.claimExpired(room, Date.now())) {
        const nextUid = room.order[(r.turnIndex + 1) % room.order.length];
        if (nextUid !== uid) applyLocal('draw', nextUid);
      }
      return;
    }
    const cur = L.currentUid(room);
    if (cur === uid) return;
    if (r.phase === 'draw') { applyLocal('draw', cur); return; }
    if (r.phase === 'discard') {
      const hand = r.hands[cur];
      if (L.canDeclare(room, cur) && Math.random() < CPU_TSUMO_CHANCE) { applyLocal('declareWin', cur, 'tsumo'); return; }
      const cards = L.cardsOf(hand);
      const pick = cards[Math.floor(Math.random() * cards.length)];
      applyLocal('discard', cur, pick);
    }
  }

  // ポン・ロンの受付中、人間以外の候補者に代わって CPU の判断をする(誰か1体が行動したら true)
  function cpuActClaim() {
    const r = room.round;
    const candidates = room.order.filter((u) => u !== uid && u !== r.lastDiscard.uid && r.claim.passed.indexOf(u) < 0);
    if (!candidates.length) return false;
    for (const bot of candidates) {
      if (L.canDeclare(room, bot) && Math.random() < CPU_RON_CHANCE) return applyLocal('declareWin', bot, 'ron');
    }
    for (const bot of candidates) {
      const cards = L.cardsOf(r.hands[bot]);
      if (cards.length >= 2 && Math.random() < CPU_PON_CHANCE) return applyLocal('pon', bot, cards.slice(0, 2));
    }
    // 誰も割り込まないなら CPU 全員まとめてパスして手番を進める
    let any = false;
    for (const bot of candidates) { if (applyLocal('passClaim', bot)) any = true; }
    return any;
  }

  // ---------------------------------------------------------------------------
  // ゲーム操作: トランザクションで GameLogic を適用(練習モードはローカルに直接適用)
  // ---------------------------------------------------------------------------
  async function runAction(fnName, ...args) {
    await flushLayout();
    if (practiceMode) {
      const fn = L[fnName];
      const res = fn(room, uid, ...args, { now: Date.now() });
      if (res.error) throw new Error(res.error);
      room = res.room;
      render();
      return;
    }
    const ref = roomRef();
    return db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('部屋がありません');
      const fn = L[fnName];
      const res = fn(doc.data(), uid, ...args, { now: Date.now() });
      if (res.error) throw new Error(res.error);
      const r = res.room;
      tx.update(ref, {
        status: r.status,
        hostUid: r.hostUid,
        settings: r.settings,
        players: r.players,
        order: r.order,
        round: r.round,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  }

  // ボタンから呼ぶ用: エラーはトーストで表示
  async function act(fnName, ...args) {
    try {
      await runAction(fnName, ...args);
    } catch (e) {
      console.warn(fnName, e);
      toast(e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 手札の並び: デバウンス送信
  // ---------------------------------------------------------------------------
  function scheduleLayout(layout) {
    pendingLayout = layout;
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => { flushLayout(); }, LAYOUT_DEBOUNCE_MS);
  }

  let layoutInflight = null; // 送信中の書き込み(操作のトランザクションはこれの完了を待つ)

  async function flushLayout() {
    clearTimeout(layoutTimer);
    if (pendingLayout && room && room.round) {
      const layout = pendingLayout;
      pendingLayout = null;
      const check = L.setLayout(room, uid, layout);
      if (check.error) {
        console.warn('layout skipped:', check.error);
      } else if (practiceMode) {
        room = check.room;
      } else {
        const path = new firebase.firestore.FieldPath('round', 'hands', uid, 'layout');
        const prev = layoutInflight;
        layoutInflight = (async () => {
          if (prev) await prev;
          try { await roomRef().update(path, layout); }
          catch (e) { console.error('layout update failed', e); }
        })();
      }
    } else {
      pendingLayout = null;
    }
    if (!practiceMode && layoutInflight) await layoutInflight;
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------
  function showScreen(name) {
    el('lobby-screen').classList.toggle('hidden', name !== 'lobby');
    el('wait-screen').classList.toggle('hidden', name !== 'wait');
    el('game-screen').classList.toggle('hidden', name !== 'game');
  }

  function nameOf(u) {
    return room && room.players[u] ? room.players[u].name : '?';
  }

  function render() {
    if (!room) { showScreen('lobby'); return; }
    if (room.status === 'lobby' || !room.round) { renderWait(); return; }
    renderGame();
  }

  function renderWait() {
    showScreen('wait');
    el('wait-room-code').textContent = roomCode;
    el('wait-count').textContent = '(' + room.order.length + '/' + L.MAX_PLAYERS + '人)';
    const ul = el('wait-players');
    ul.innerHTML = '';
    room.order.forEach((u) => {
      const li = document.createElement('li');
      li.textContent = (u === room.hostUid ? '👑 ' : '') + nameOf(u) + (u === uid ? '(あなた)' : '');
      ul.appendChild(li);
    });
    const s = room.settings;
    el('wait-settings').textContent =
      (s.mode === 'advanced' ? 'じょうきゅう(13枚)' : 'きほん(7枚)') +
      ' / 手札' + (s.openHands ? '公開' : '非公開') +
      (s.mode === 'advanced' ? ' / 受付' + s.claimSeconds + '秒' : '');
    const isHost = room.hostUid === uid;
    el('start-game-btn').classList.toggle('hidden', !isHost);
    el('start-game-btn').disabled = room.order.length < L.MIN_PLAYERS;
    el('wait-msg').textContent = isHost
      ? (room.order.length < L.MIN_PLAYERS ? 'あと' + (L.MIN_PLAYERS - room.order.length) + '人待っています' : '')
      : 'ホストが「はじめる」を押すのを待っています';
  }

  function renderGame() {
    showScreen('game');
    const r = room.round;
    el('hud-room-item').innerHTML = practiceMode
      ? '🤖 練習モード'
      : '部屋 <strong id="game-room-code">' + roomCode + '</strong>';
    el('round-no').textContent = r.no;
    el('deck-count').textContent = r.deck.length;
    el('mode-label').textContent = room.settings.mode === 'advanced' ? 'じょうきゅう' : 'きほん';
    renderBanner();
    renderOthers();
    renderMyHand();
    renderActions();
    renderModal();
    manageClaimTimer();
    scheduleCpu();
  }

  function renderBanner() {
    const r = room.round;
    const cur = L.currentUid(room);
    const b = el('banner');
    b.className = 'banner';
    let text = '';
    if (r.phase === 'draw') {
      if (cur === uid) { text = 'あなたの番です。「ツモ」を押してね'; b.classList.add('banner--mine'); }
      else text = nameOf(cur) + 'さんの番を待っています';
    } else if (r.phase === 'discard') {
      if (cur === uid) { text = 'いらないカードを1枚えらんで「捨てる」'; b.classList.add('banner--mine'); }
      else text = nameOf(cur) + 'さんが捨てるカードをえらんでいます';
    } else if (r.phase === 'claim') {
      const sec = Math.max(0, Math.ceil((r.claim.deadline - Date.now()) / 1000));
      if (r.lastDiscard.uid === uid) text = 'ほかの人がポン・ロンできる時間です(' + sec + ')';
      else { text = nameOf(r.lastDiscard.uid) + 'さんの「' + C.charOf(r.lastDiscard.cardId) + '」をポン・ロンできます(' + sec + ')'; b.classList.add('banner--claim'); }
    } else if (r.phase === 'declare') {
      if (r.declaration.uid === uid) { text = 'みんなに見せて確認。よければ「成立!」'; b.classList.add('banner--mine'); }
      else { text = nameOf(r.declaration.uid) + 'さんがあがり宣言中!'; b.classList.add('banner--claim'); }
    } else if (r.phase === 'result') {
      text = nameOf(r.winner) + 'さんのあがり!';
    }
    b.textContent = text;
  }

  function renderOthers() {
    const r = room.round;
    const cur = L.currentUid(room);
    const box = el('others');
    box.innerHTML = '';
    room.order.filter((u) => u !== uid).forEach((u) => {
      const p = document.createElement('div');
      p.className = 'player' + (cur === u ? ' player--turn' : '');
      const head = document.createElement('div');
      head.className = 'row';
      head.innerHTML = '<span class="player__name"></span><span class="muted"></span>';
      head.children[0].textContent = nameOf(u);
      head.children[1].textContent = room.players[u].wins + '勝 / ' + L.totalCount(r.hands[u]) + '枚';
      p.appendChild(head);
      const body = document.createElement('div');
      body.className = 'row';
      r.hands[u].melds.forEach((m) => body.appendChild(meldEl(m)));
      const hand = document.createElement('div');
      HandUI.renderReadonlyHand(hand, r.hands[u].layout, {
        hidden: !room.settings.openHands, count: L.cardsOf(r.hands[u]).length, size: 'sm',
      });
      body.appendChild(hand);
      p.appendChild(body);
      p.appendChild(discardsEl(u));
      box.appendChild(p);
    });
  }

  function meldEl(m) {
    const d = document.createElement('span');
    d.className = 'meld hand';
    d.dataset.size = 'sm';
    m.cards.forEach((id) => {
      const c = document.createElement('span');
      c.className = 'card';
      c.textContent = C.charOf(id);
      d.appendChild(c);
    });
    return d;
  }

  function discardsEl(u) {
    const r = room.round;
    const d = document.createElement('div');
    d.className = 'discards hand';
    d.dataset.size = 'sm';
    r.discards[u].forEach((id, i, arr) => {
      const c = document.createElement('span');
      c.className = 'card';
      if (r.lastDiscard && r.lastDiscard.uid === u && i === arr.length - 1) c.classList.add('card--last');
      c.textContent = C.charOf(id);
      d.appendChild(c);
    });
    return d;
  }

  function renderMyHand() {
    const r = room.round;
    const hand = r.hands[uid];
    el('my-name').textContent = nameOf(uid) + '(あなた)';
    if (!hand) { el('my-hand').innerHTML = '<p class="muted">観戦中</p>'; return; }
    el('my-count').textContent = room.players[uid].wins + '勝 / ' + L.totalCount(hand) + '枚';

    const melds = el('my-melds');
    melds.innerHTML = '';
    hand.melds.forEach((m) => melds.appendChild(meldEl(m)));

    // 未送信の並びがあればそれを優先し、サーバー上のカード集合と突き合わせる
    const serverCards = L.cardsOf(hand);
    const base = pendingLayout || hand.layout;
    const layout = L.reconcileLayout(base, serverCards);

    if (!handEditor) {
      handEditor = HandUI.createHandEditor(el('my-hand'), {
        layout,
        onChange: (l) => { scheduleLayout(l); el('undo-btn').disabled = !handEditor.canUndo(); renderWordsPreview(l); },
        onSelect: onHandSelect,
      });
    }
    renderWordsPreview(layout);
    const editable = r.phase !== 'result';
    handEditor.setEditable(editable);
    handEditor.setLayout(layout, { drawn: r.drawnCard && L.currentUid(room) === uid ? r.drawnCard : null, highlight: ponPick || [] });
    el('undo-btn').disabled = !handEditor.canUndo();

    const mine = el('my-discards');
    mine.innerHTML = '';
    mine.appendChild(discardsEl(uid));
  }

  // 宣言中の宣言者に、現在の並びを言葉ごとに区切って見せる
  function renderWordsPreview(layout) {
    const r = room.round;
    const box = el('words-preview');
    const show = r.phase === 'declare' && r.declaration.uid === uid;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    box.innerHTML = '';
    const hand = r.hands[uid];
    hand.melds.forEach((md) => {
      const w = document.createElement('span');
      w.className = 'word word--meld';
      w.textContent = md.cards.map(C.charOf).join('');
      box.appendChild(w);
    });
    C.layoutToWords(layout).forEach((t) => {
      const w = document.createElement('span');
      w.className = 'word';
      w.textContent = t;
      box.appendChild(w);
    });
  }

  function onHandSelect(id) {
    if (ponPick) {
      // ポン選択モード: 最大2枚まで選ぶ
      if (id) {
        const i = ponPick.indexOf(id);
        if (i >= 0) ponPick.splice(i, 1);
        else if (ponPick.length < 2) ponPick.push(id);
        handEditor.clearSelection();
      }
      handEditor.setHighlight(ponPick);
      renderActions();
      return;
    }
    selectedCardId = id;
    renderActions();
  }

  function renderActions() {
    const r = room.round;
    const cur = L.currentUid(room);
    const box = el('actions');
    box.innerHTML = '';
    if (!r.hands[uid]) return;
    const add = (label, cls, onClick, disabled, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.disabled = !!disabled;
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      box.appendChild(b);
      return b;
    };
    const declareBtn = () => add('あがり!', 'danger', () => act('declareWin', 'tsumo'), !L.canDeclare(room, uid),
      'ちょうど' + L.winningCount(room.settings.mode) + '枚のときに押せます');

    if (r.phase === 'draw') {
      if (cur === uid) add('ツモ(1枚引く)', 'primary', () => act('draw'));
      else add('待っています…', '', null, true);
    } else if (r.phase === 'discard') {
      if (cur === uid) {
        if (selectedCardId) {
          add('「' + C.charOf(selectedCardId) + '」を捨てる', 'primary', () => {
            const id = selectedCardId;
            selectedCardId = null;
            handEditor.clearSelection();
            act('discard', id);
          });
        } else {
          add('捨てるカードをタップしてね', '', null, true);
        }
        declareBtn();
      } else {
        add('待っています…', '', null, true);
      }
    } else if (r.phase === 'claim') {
      const nextUid = room.order[(r.turnIndex + 1) % room.order.length];
      if (r.lastDiscard.uid === uid) {
        add('待っています…', '', null, true);
      } else if (ponPick) {
        add('カードを2枚えらんでね(' + ponPick.length + '/2)', '', null, true);
        add('ポンする', 'danger', () => { const pick = ponPick.slice(); ponPick = null; handEditor.setHighlight([]); act('pon', pick); }, ponPick.length !== 2);
        add('やめる', '', () => { ponPick = null; handEditor.setHighlight([]); renderActions(); });
      } else {
        const expired = L.claimExpired(room, Date.now());
        if (nextUid === uid) add('ツモ(1枚引く)', 'primary', () => act('draw'), !expired, '受付時間がおわると引けます');
        // 受付時間が過ぎても次の人が引くまではポン・ロンできる(早い者勝ち。競合はトランザクションで解決)
        add('ポン', 'danger', () => { ponPick = []; handEditor.clearSelection(); renderActions(); });
        add('ロン', 'danger', () => act('declareWin', 'ron'), !L.canDeclare(room, uid));
        add('パス', '', () => act('passClaim'), r.claim.passed.indexOf(uid) >= 0);
      }
    } else if (r.phase === 'declare' && r.declaration.uid === uid) {
      // 宣言者はモーダルで塞がず、手札を並べ直しながら確定できる
      add('成立!', 'ok', () => act('confirmWin'));
      add('取り消し', '', () => act('cancelWin'));
    }
    // result はモーダル側で操作する
  }

  function renderModal() {
    const r = room.round;
    const m = el('modal');
    const isDeclarer = r.phase === 'declare' && r.declaration.uid === uid;
    if ((r.phase !== 'declare' && r.phase !== 'result') || isDeclarer) { m.classList.add('hidden'); m.innerHTML = ''; return; }
    m.classList.remove('hidden');
    m.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'modal__box';
    const who = r.phase === 'declare' ? r.declaration.uid : r.winner;
    const hand = r.hands[who];
    const h = document.createElement('h2');
    h.textContent = r.phase === 'declare'
      ? nameOf(who) + 'さんの あがり宣言' + (r.declaration.type === 'ron' ? '(ロン)' : '')
      : nameOf(who) + 'さんの あがり!';
    box.appendChild(h);
    const words = document.createElement('div');
    words.className = 'words';
    hand.melds.forEach((md) => {
      const w = document.createElement('span');
      w.className = 'word word--meld';
      w.textContent = md.cards.map(C.charOf).join('');
      words.appendChild(w);
    });
    C.layoutToWords(hand.layout).forEach((t) => {
      const w = document.createElement('span');
      w.className = 'word';
      w.textContent = t;
      words.appendChild(w);
    });
    box.appendChild(words);
    const row = document.createElement('div');
    row.className = 'row';
    if (r.phase === 'declare') {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = '言葉になっているか、みんなで確認中…(' + nameOf(who) + 'さんが「成立」か「取り消し」を押します)';
      box.appendChild(note);
    } else {
      const tally = document.createElement('p');
      tally.textContent = room.order.map((u) => nameOf(u) + ' ' + room.players[u].wins + '勝').join(' / ');
      box.appendChild(tally);
      if (room.hostUid === uid) row.appendChild(btn('次の局へ', 'primary', () => act('nextRound')));
      else {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'ホストが「次の局へ」を押すのを待っています';
        box.appendChild(p);
      }
      row.appendChild(btn('部屋を出る', '', () => leaveRoom()));
    }
    box.appendChild(row);
    m.appendChild(box);
  }

  function btn(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  // claim 中だけ毎秒バナーとボタンを更新する
  function manageClaimTimer() {
    const active = room && room.round && room.round.phase === 'claim';
    if (active && !claimTimer) {
      claimTimer = setInterval(() => { if (room && room.round && room.round.phase === 'claim') { renderBanner(); if (!ponPick) renderActions(); } }, 500);
    } else if (!active && claimTimer) {
      clearInterval(claimTimer);
      claimTimer = null;
      ponPick = null;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
  }

  // ---------------------------------------------------------------------------
  // イベント登録
  // ---------------------------------------------------------------------------
  function bindEvents() {
    try {
      const saved = localStorage.getItem('hiragajan:name');
      if (saved) el('name-input').value = saved;
    } catch (_) { /* noop */ }
    el('create-room-btn').addEventListener('click', createRoom);
    el('practice-btn').addEventListener('click', () => {
      try { startPractice(); } catch (e) { console.error(e); el('lobby-error').textContent = '練習モードの開始に失敗しました: ' + e.message; }
    });
    el('join-room-btn').addEventListener('click', () => joinRoom(el('room-code-input').value.trim()));
    el('room-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(el('room-code-input').value.trim()); });
    el('leave-room-btn').addEventListener('click', leaveRoom);
    el('copy-link-btn').addEventListener('click', async () => {
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomCode);
      try { await navigator.clipboard.writeText(url.toString()); toast('リンクをコピーしました'); }
      catch (_) { toast(url.toString()); }
    });
    el('start-game-btn').addEventListener('click', () => act('startGame'));
    el('undo-btn').addEventListener('click', () => { if (handEditor) handEditor.undo(); });
    el('clear-spaces-btn').addEventListener('click', () => { if (handEditor) handEditor.clearSpaces(); });
    window.addEventListener('beforeunload', () => { flushLayout(); });
  }

  bindEvents();
  initFirebase();

  // デバッグ用にコンソールから触れるようにしておく
  window.Hiragajan = { get room() { return room; }, get uid() { return uid; }, act, runAction };
})();
