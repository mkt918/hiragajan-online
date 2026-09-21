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

  // 端末の時計ずれ対策: サーバーが書いた updatedAt と受信時刻の差で補正する(誤差は通信遅延程度)
  let serverOffset = 0;
  function nowMs() { return practiceMode ? Date.now() : Date.now() + serverOffset; }

  // 在席確認(ホスト不在の検知用)。この間隔で players.{uid}.lastSeenAt を更新する
  const HEARTBEAT_MS = 15000;
  let heartbeatTimer = null;

  let busy = false; // 操作の二重送信防止(連打対策)

  const el = (id) => document.getElementById(id);
  const roomRef = () => db.collection('rooms').doc(roomCode);

  // Firestore のエラーを利用者向けの日本語にする
  function friendlyError(e) {
    const code = e && e.code ? String(e.code) : '';
    if (code.indexOf('unavailable') >= 0 || code.indexOf('deadline') >= 0 || /offline/i.test(e && e.message || '')) {
      return '通信できませんでした。電波を確認してもう一度押してね';
    }
    if (code.indexOf('permission-denied') >= 0) return 'この操作はできません(接続をやり直してみてね)';
    if (code.indexOf('failed-precondition') >= 0 || code.indexOf('aborted') >= 0) return '同時に操作があったのでやり直してね';
    return (e && e.message) || 'エラーが起きました';
  }

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
    if (practiceMode || roomCode) return;
    const code = new URLSearchParams(window.location.search).get('room');
    if (!code || !/^\d{4}$/.test(code)) return;
    el('room-code-input').value = code;
    // 名前が未設定のまま自動参加すると全員「プレイヤー」になるので、初めての端末では名前入力を促す
    if (el('name-input').value.trim()) {
      joinRoom(code);
    } else {
      el('connection-status').textContent = '部屋コード ' + code + ' に入ります。なまえを入れて「入る」を押してね';
      el('name-input').focus();
    }
  }

  function myName() {
    const v = el('name-input').value.trim();
    const name = v || 'プレイヤー';
    try { localStorage.setItem('hiragajan:name', name); } catch (_) { /* noop */ }
    return name;
  }

  // 自分の手札の見せ方(自動折り返し/1〜4列)。端末ごとの好みなので localStorage に保存する。
  function loadHandCols() {
    try { return localStorage.getItem('hiragajan:handCols') || '0'; } catch (_) { return '0'; }
  }
  function applyHandCols(value) {
    const hand = el('my-hand');
    hand.dataset.cols = value;
    hand.style.setProperty('--hand-cols', value);
  }

  // ---------------------------------------------------------------------------
  // 部屋の作成・参加・退室
  // ---------------------------------------------------------------------------
  function generateRoomCode() {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  }

  async function createRoom() {
    el('lobby-error').textContent = '';
    if (!uid || practiceMode) { el('lobby-error').textContent = '接続がまだ終わっていません。少し待ってからもう一度押してね。'; return; }
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
    if (!uid || practiceMode) { el('lobby-error').textContent = '接続がまだ終わっていません。少し待ってからもう一度押してね。'; return; }
    const name = myName();
    const ref = db.collection('rooms').doc(code);
    try {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error('その部屋はありません。');
        const res = L.joinRoom(doc.data(), uid, name, nowMs());
        if (res.error) throw new Error(res.error);
        tx.update(ref, {
          players: res.room.players,
          order: res.room.order,
          hostUid: res.room.hostUid,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      enterRoom(code);
    } catch (e) {
      el('lobby-error').textContent = friendlyError(e);
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
      // サーバーが確定した書き込みの updatedAt から時計ずれを推定する
      if (!doc.metadata.hasPendingWrites && room.updatedAt && typeof room.updatedAt.toMillis === 'function') {
        serverOffset = room.updatedAt.toMillis() - Date.now();
      }
      render();
    }, (err) => {
      console.error(err);
      toast('接続エラー: ' + friendlyError(err));
    });
    startHeartbeat();
  }

  let hostCheckTimer = null;
  function startHeartbeat() {
    stopHeartbeat();
    const beat = async () => {
      if (!roomCode || !uid || practiceMode) return;
      try {
        await roomRef().update(new firebase.firestore.FieldPath('players', uid, 'lastSeenAt'), nowMs());
      } catch (e) { /* 退室済み・権限なし等は無視 */ }
    };
    beat();
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    // 書き込みが無い間もホスト不在を検知できるよう、定期的に判定し直す
    hostCheckTimer = setInterval(() => { if (room && roomCode) renderHostControls(); }, 10000);
  }
  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clearInterval(hostCheckTimer);
    hostCheckTimer = null;
  }

  // 画面上の一時状態(選択・ポン選択・受付タイマー)を片付ける。部屋を出るとき共通
  function resetTransientUi() {
    clearInterval(claimTimer);
    claimTimer = null;
    ponPick = null;
    selectedCardId = null;
    pendingLayout = null;
    clearTimeout(layoutTimer);
  }

  async function leaveRoom() {
    if (practiceMode) {
      practiceMode = false;
      clearTimeout(cpuTimer);
      cpuTimer = null;
      uid = realUid; // 本物の Firebase uid に戻す
      room = null;
      roomCode = null;
      resetTransientUi();
      showScreen('lobby');
      return;
    }
    // ロビー中なら参加者リストから抜ける。ゲーム中は手札を山札に戻して抜ける(残った人の卓が止まらないように)
    if (room && L.isPlayer(room, uid)) {
      try { await runAction(room.status === 'lobby' ? 'leaveRoom' : 'leaveGame'); }
      catch (e) { console.warn('leave failed', e); }
    }
    stopHeartbeat();
    if (unsubscribeRoom) unsubscribeRoom();
    unsubscribeRoom = null;
    roomCode = null;
    room = null;
    resetTransientUi();
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
    resetTransientUi();

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

  // CPU は「あがり」(ツモ・ロン)を一切しない。
  // 配布枚数+1=あがり枚数(基本7→8、上級13→14)という設計上、ツモ直後・ポン直後は
  // 「枚数だけ」なら毎回あがり宣言できてしまう(役の妥当性は判定しない設計のため)。
  // CPU にあがり判断をさせると際限なく終局してしまうので、あがりは常に人間だけが行う。
  // ポンは局を進める(終わらせない)操作なので CPU にも許可している。
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
  // CPU はあがらないので、あがり宣言中(declare)は常に人間の宣言 → 人間の操作待ち。CPU の出番はない。
  function scheduleCpu() {
    clearTimeout(cpuTimer);
    cpuTimer = null;
    if (!practiceMode || !room || !room.round) return;
    const r = room.round;
    let needsBot = false;
    if (r.phase === 'claim') needsBot = true; // 何もすることがなければ cpuTick が無視する
    else if (r.phase === 'draw' || r.phase === 'discard') needsBot = L.currentUid(room) !== uid;
    if (needsBot) cpuTimer = setTimeout(cpuTick, 700);
  }

  function cpuTick() {
    if (!practiceMode || !room || !room.round) return;
    const r = room.round;
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
      const cards = L.cardsOf(r.hands[cur]);
      const pick = cards[Math.floor(Math.random() * cards.length)];
      applyLocal('discard', cur, pick);
    }
  }

  // ポン受付中、人間以外の候補者に代わって CPU の判断をする(誰か1体が行動したら true)。
  // CPU はロンをしない(あがりは常に人間だけ)。
  function cpuActClaim() {
    const r = room.round;
    const candidates = room.order.filter((u) => u !== uid && u !== r.lastDiscard.uid && r.claim.passed.indexOf(u) < 0);
    if (!candidates.length) return false;
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
      const res = fn(doc.data(), uid, ...args, { now: nowMs() });
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

  // ボタンから呼ぶ用: 実行中は二重送信を防ぎ、エラーは日本語トーストで表示
  async function act(fnName, ...args) {
    if (busy) return;
    busy = true;
    setActionsBusy(true);
    try {
      await runAction(fnName, ...args);
    } catch (e) {
      console.warn(fnName, e);
      toast(friendlyError(e));
    } finally {
      busy = false;
      setActionsBusy(false);
    }
  }

  function setActionsBusy(flag) {
    document.querySelectorAll('#actions button, #discard-zone, #modal button, #start-game-btn').forEach((b) => {
      if (flag) { if (!b.disabled) { b.dataset.busyDisabled = '1'; b.disabled = true; } }
      else if (b.dataset.busyDisabled) { delete b.dataset.busyDisabled; b.disabled = false; }
    });
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

  // 席の色分け(名前の頭文字を丸バッジにして「誰が誰か」を一目で分かりやすくする)
  function seatColorIndex(u) {
    let h = 0;
    for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0;
    return h % 4;
  }
  // 「CPU1」「CPU2」のように名前が数字で終わる場合はその数字を、それ以外は先頭の文字を表示する
  // (先頭文字だけだと CPU1/CPU2/CPU3 が全員「C」になって区別できないため)
  function avatarLabel(name) {
    const trimmed = (name || '').trim();
    const last = trimmed.charAt(trimmed.length - 1);
    if (/[0-9]/.test(last)) return last;
    return trimmed.charAt(0) || '?';
  }
  function applyAvatar(el2, u) {
    el2.textContent = avatarLabel(nameOf(u));
    el2.className = 'seat-avatar seat-avatar--' + seatColorIndex(u);
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
    renderHostControls();
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
    renderHostControls();
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
      if (ponPick) { text = '🀄 自分の手札から2枚選んで言葉を成立させてね(' + ponPick.length + '/2)'; b.classList.add('banner--claim'); }
      else {
        const sec = Math.max(0, Math.ceil((r.claim.deadline - nowMs()) / 1000));
        if (r.lastDiscard.uid === uid) text = 'ほかの人がポン・ロンできる時間です(' + sec + ')';
        else { text = nameOf(r.lastDiscard.uid) + 'さんの「' + C.charOf(r.lastDiscard.cardId) + '」をポン・ロンできます(' + sec + ')'; b.classList.add('banner--claim'); }
      }
    } else if (r.phase === 'declare') {
      if (r.declaration.uid === uid) { text = 'みんなに見せて確認。よければ「成立!」'; b.classList.add('banner--mine'); }
      else { text = nameOf(r.declaration.uid) + 'さんがあがり宣言中!'; b.classList.add('banner--claim'); }
    } else if (r.phase === 'result') {
      text = r.winner ? nameOf(r.winner) + 'さんのあがり!' : '流局(この局はあがりなし)';
    }
    b.textContent = text;
  }

  // ホストが不在のとき「ホストを引き継ぐ」、ホスト自身には「手番を進める」を出す(オンラインのみ)
  function renderHostControls() {
    const takeBtn = el('take-host-btn');
    const waitTakeBtn = el('wait-take-host-btn');
    const canTake = !practiceMode && room && L.isPlayer(room, uid) && room.hostUid !== uid && L.hostIsStale(room, nowMs());
    takeBtn.classList.toggle('hidden', !canTake);
    waitTakeBtn.classList.toggle('hidden', !canTake);
    const leaveBtn = el('leave-game-btn');
    leaveBtn.classList.toggle('hidden', !room || !room.round);
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
      head.innerHTML = '<span class="seat-avatar"></span><span class="player__name"></span><span class="muted"></span>';
      applyAvatar(head.children[0], u);
      head.children[1].textContent = nameOf(u);
      head.children[2].textContent = room.players[u].wins + '勝 / ' + L.totalCount(r.hands[u]) + '枚';
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
      p.appendChild(discardsEl(u, '🗑️ ' + nameOf(u) + 'の捨て札'));
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

  // 捨て札を「ラベル付きの箱」として描画する(手札や場札と混同されないように区別する)
  function discardsEl(u, label) {
    const r = room.round;
    const wrap = document.createElement('div');
    wrap.className = 'discard-pile';
    const lab = document.createElement('p');
    lab.className = 'discard-pile__label';
    lab.textContent = label;
    wrap.appendChild(lab);
    const d = document.createElement('div');
    d.className = 'discards hand';
    d.dataset.size = 'sm';
    if (r.discards[u].length === 0) {
      const empty = document.createElement('span');
      empty.className = 'discard-pile__empty';
      empty.textContent = 'まだありません';
      d.appendChild(empty);
    } else {
      r.discards[u].forEach((id, i, arr) => {
        const c = document.createElement('span');
        c.className = 'card';
        if (r.lastDiscard && r.lastDiscard.uid === u && i === arr.length - 1) c.classList.add('card--last');
        c.textContent = C.charOf(id);
        d.appendChild(c);
      });
    }
    wrap.appendChild(d);
    return wrap;
  }

  function renderMyHand() {
    const r = room.round;
    const hand = r.hands[uid];
    applyAvatar(el('my-avatar'), uid);
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
        // 捨てるゾーンへドラッグ&ドロップされたら、そのまま捨てる(タップ選択と同じ act を呼ぶ)
        onDropToZone: (cardId) => act('discard', cardId),
        onDragOverZone: (isOver) => el('discard-zone').classList.toggle('discard-zone--over', isOver),
      });
    }
    renderWordsPreview(layout);
    const editable = r.phase !== 'result';
    handEditor.setEditable(editable);
    handEditor.setLayout(layout, { drawn: r.drawnCard && L.currentUid(room) === uid ? r.drawnCard : null, highlight: ponPick || [] });
    handEditor.setDropZone(r.phase === 'discard' && L.currentUid(room) === uid ? el('discard-zone') : null);
    el('undo-btn').disabled = !handEditor.canUndo();

    const mine = el('my-discards');
    mine.innerHTML = '';
    mine.appendChild(discardsEl(uid, '🗑️ 自分の捨て札'));
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
      // 捨てる操作は手札の下の「捨てるゾーン」で行う(タップして選択→ゾーンをタップ、またはドラッグ)。
      if (cur === uid) {
        if (selectedCardId) add('キャンセル', '', () => handEditor.clearSelection());
        declareBtn();
      } else add('待っています…', '', null, true);
    } else if (r.phase === 'claim') {
      const nextUid = room.order[(r.turnIndex + 1) % room.order.length];
      if (r.lastDiscard.uid === uid) {
        add('待っています…', '', null, true);
      } else if (ponPick) {
        add('自分の手札から2枚選んで言葉を成立させてね(' + ponPick.length + '/2)', '', null, true);
        add('ポンする', 'danger', () => { const pick = ponPick.slice(); ponPick = null; handEditor.setHighlight([]); act('pon', pick); }, ponPick.length !== 2);
        add('キャンセル', '', () => { ponPick = null; handEditor.setHighlight([]); renderActions(); });
      } else {
        const expired = L.claimExpired(room, nowMs());
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
    // ホスト用: 止まっている手番を進める(離脱・放置対策)。自分の番のときは不要
    if (!practiceMode && room.hostUid === uid && r.phase !== 'result') {
      const actor = r.phase === 'declare' ? r.declaration.uid : (r.phase === 'claim' ? null : cur);
      if (actor !== uid) {
        const label = r.phase === 'declare' ? '⏭ 宣言を取り消して進める' : (r.phase === 'claim' ? '⏭ 受付を終わって進める' : '⏭ ' + nameOf(cur) + 'さんの番を飛ばす');
        add(label, 'btn-sm', () => {
          if (window.confirm('止まっている手番をホストの権限で進めます。よろしいですか?')) act('forceAdvance');
        });
      }
    }
    // result はモーダル側で操作する
    renderDiscardZone();
  }

  // 手札の下の「捨てるゾーン」の表示を選択状態に合わせて更新する
  function renderDiscardZone() {
    const r = room.round;
    const zone = el('discard-zone');
    const active = r.phase === 'discard' && L.currentUid(room) === uid;
    zone.classList.toggle('hidden', !active);
    if (!active) { zone.textContent = ''; zone.disabled = true; return; }
    zone.disabled = !selectedCardId;
    zone.classList.toggle('discard-zone--active', !!selectedCardId);
    zone.textContent = selectedCardId
      ? '🗑️ 「' + C.charOf(selectedCardId) + '」をここに捨てる'
      : '🗑️ カードをここへドラッグ、またはタップして選んでからここをタップ';
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
    const hand = who ? r.hands[who] : null;
    const h = document.createElement('h2');
    if (r.phase === 'declare') h.textContent = nameOf(who) + 'さんの あがり宣言' + (r.declaration.type === 'ron' ? '(ロン)' : '');
    else if (who) h.textContent = nameOf(who) + 'さんの あがり!';
    else h.textContent = '流局';
    box.appendChild(h);
    if (hand) {
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
    } else {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = room.order.length < L.MIN_PLAYERS ? '人数が足りなくなったので、この局は終わりです' : '山札も河も無くなったので、この局はあがりなしで終わりです';
      box.appendChild(p);
    }
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
      if (room.order.length < L.MIN_PLAYERS) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = '2人以上いないと次の局は始められません。部屋を出て作り直してね';
        box.appendChild(p);
      } else if (room.hostUid === uid) row.appendChild(btn('次の局へ', 'primary', () => act('nextRound')));
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

  // claim 中だけカウントダウンを更新する。ボタンを毎回作り直すとタップが取りこぼされるので、
  // ボタンの再描画は「受付が終わった/戻った」瞬間だけにする
  let lastClaimExpired = null;
  function manageClaimTimer() {
    const active = room && room.round && room.round.phase === 'claim';
    if (active && !claimTimer) {
      lastClaimExpired = L.claimExpired(room, nowMs());
      claimTimer = setInterval(() => {
        if (!(room && room.round && room.round.phase === 'claim')) return;
        renderBanner();
        const expired = L.claimExpired(room, nowMs());
        if (expired !== lastClaimExpired) {
          lastClaimExpired = expired;
          if (!ponPick && !busy) renderActions();
        }
      }, 500);
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
    const handColsInput = el('hand-cols-input');
    handColsInput.value = loadHandCols();
    applyHandCols(handColsInput.value);
    handColsInput.addEventListener('change', () => {
      try { localStorage.setItem('hiragajan:handCols', handColsInput.value); } catch (_) { /* noop */ }
      applyHandCols(handColsInput.value);
    });
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
    el('discard-zone').addEventListener('click', () => {
      const id = handEditor && handEditor.getSelected();
      if (!id) return; // 未選択でのタップは何もしない(ドラッグ&ドロップは別経路で処理される)
      handEditor.clearSelection();
      act('discard', id);
    });
    el('leave-game-btn').addEventListener('click', () => {
      const msg = practiceMode ? '練習をやめてロビーに戻りますか?' : '部屋を出ますか?(手札は山札に戻り、残りの人でゲームが続きます)';
      if (window.confirm(msg)) leaveRoom();
    });
    const takeHost = () => { if (window.confirm('ホストが応答していません。あなたがホストになりますか?')) act('takeHost'); };
    el('take-host-btn').addEventListener('click', takeHost);
    el('wait-take-host-btn').addEventListener('click', takeHost);

    // ルール選択の見た目: :has() 非対応ブラウザ向けにクラスでも表現する
    const syncModeClass = () => {
      document.querySelectorAll('.mode-option').forEach((lab) => {
        lab.classList.toggle('mode-option--checked', lab.querySelector('input').checked);
      });
    };
    document.querySelectorAll('input[name="mode"]').forEach((i) => i.addEventListener('change', syncModeClass));
    syncModeClass();

    // 並び替えの取りこぼしを減らす: 画面が隠れた時点で送る(タブ閉じ直前は間に合わないことがある)
    window.addEventListener('beforeunload', () => { flushLayout(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushLayout(); });

    // 同じブラウザで2つ目のタブを開くと同じプレイヤーとして二重に操作できてしまうので注意を出す
    try {
      const tabId = String(Math.random());
      localStorage.setItem('hiragajan:tab', tabId);
      window.addEventListener('storage', (e) => {
        if (e.key === 'hiragajan:tab' && e.newValue && e.newValue !== tabId) {
          toast('別のタブでも開かれています。操作は1つのタブで行ってね');
        }
      });
    } catch (_) { /* noop */ }
  }

  bindEvents();
  initFirebase();

  // デバッグ用にコンソールから触れるようにしておく
  window.Hiragajan = { get room() { return room; }, get uid() { return uid; }, act, runAction };
})();
