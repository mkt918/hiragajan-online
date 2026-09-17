# ひらがじゃん オンライン

ひらがなカード120枚で、麻雀のように「言葉」を揃えるカードゲーム「ひらがじゃん」の Web アプリ版。
2〜8人がスマホ/PC から部屋コードで集まり、リアルタイムで対戦する。Firebase(Firestore + 匿名認証)+ GitHub Pages。

**公開URL**: https://mkt918.github.io/hiragajan-online/ (GitHub Pages 設定後に有効)

## 現在の状況(2026-09-17)

| 項目 | 状態 |
|---|---|
| ゲームロジック(基本/上級、ポン/ロン、宣言/取り消し、山札切れ再シャッフル) | 完成・`node js/tests.js` 24件 PASS |
| 手札 UI(タップ/ドラッグ並べ替え、スペース挿入、もどす) | 完成 |
| Firebase 同期(部屋作成/参加、トランザクション、並びのデバウンス送信) | 完成 |
| 最大人数 | **8人**(部屋コードは4桁のまま。`GameLogic.MAX_PLAYERS` と `firestore.rules` の両方で制御) |
| 練習モード(CPU対戦、1台の端末で動作確認) | 完成(下記「練習モード」参照) |
| Firebase プロジェクト `hiragajan-online`(Firestore asia-northeast1、匿名認証) | 作成済み・ルール適用済み |
| デザイン(hallmark トークン再生成・ロビー/待機/ゲーム画面の作り込み) | 完成 |
| モバイル調整(横スクロール禁止・44pxタップ領域・カード折り返し) | 確認済み(375px 幅で実プレイ検証) |
| `docs/rules.md`(裁定表) | 完成 |
| GitHub リポジトリ | 作成・push 済み(このリポジトリ) |
| GitHub Pages 公開 | 有効化済み: https://mkt918.github.io/hiragajan-online/ |
| GitHub Actions Secret `FIREBASE_TOKEN` | **未設定(ユーザー実機での作業が必要。下記参照)** |

## 練習モード(動作確認用)

ロビー画面の「部屋をつくる」の下に「🤖 ひとりで練習」ボタンがある。2台目の端末やタブを開かなくても、CPU(1〜7体、選択したルール設定のまま)と対戦してゲーム全体の流れを確認できる。

- Firebase を一切使わず、ブラウザの中だけで完結する(オフラインでも動く)
- CPU は自動でツモ・捨て・パスを行い、ときどき(じょうきゅうのみ・意図的に低い確率で)ポンをする
- **CPU は「あがり」(ツモ・ロン)を一切しない。** あがり宣言は常に人間だけが行う
  - 配布枚数+1枚=あがり枚数(基本7→8、上級13→14)という設計上、ツモ直後・ポン直後は「枚数だけ」ならほぼ毎回あがり宣言できてしまう(役の妥当性は判定しない設計のため)。CPU にあがり判断をさせると際限なく終局してしまうので、あがりのタイミングは常に自分でコントロールできるようにしている
  - ポンの確率は `js/app.js` の `CPU_PON_CHANCE` で調整できる
- 部屋コードは発行されない(HUDに「🤖 練習モード」と表示される)。「部屋を出る」でロビーに戻る

## 遊び方

1. トップ画面でなまえを入力し、「部屋をつくる」でルール(きほん/じょうきゅう)と手札公開設定を選ぶ
2. 表示された4桁の部屋コード(またはコピーしたリンク)をほかのプレイヤーに伝える
3. 2〜8人集まったらホストが「はじめる」を押す
4. 自分の番になったら「ツモ」→ 手札を並べ替えてスペースで言葉の区切りをつくる → いらないカードをタップして「捨てる」
5. 手札がぴったりの枚数になったら「あがり!」。全員の画面に言葉ごとの区切りが表示されるので、実在する言葉になっているか相談し、宣言者が「成立」か「取り消し」を押す
6. (じょうきゅうルール)誰かの捨て札に「ポン」「ロン」ができる。詳しい手順・裁定は [docs/rules.md](docs/rules.md) を参照

## ルール概要

- カード: 清音45種×2枚 + 濁音・半濁音25種×1枚 + っゃゅょー×1枚 = 120枚(「を」なし)
- **きほん**: 7枚配布。山札から1枚引いて8枚にし、「2文字 + 3文字 + 3文字」の実在する言葉ができたらあがり。できなければ1枚捨てて次の人へ
- **じょうきゅう**: 13枚配布。14枚で「2 + 3 + 3 + 3 + 3」または「2×7(七対子)」。誰の捨て札でもポン(捨て札+手札2枚を場に固定→1枚捨てる→ポンした人の次から再開)。他人の捨て札であがる「ロン」もあり
- **あがりの判定は手動**: 宣言すると全員の画面に手札が言葉ごとに区切って大きく表示される。口頭で相談し、宣言者が「成立」か「取り消し」を押す(アプリは枚数しか見ない)
- 山札が尽きたら全員の捨て札をシャッフルして山札に戻す
- 最初の手番はランダム、以降は前の局の勝者から。勝ち数は部屋内で累計

詳しい裁定(役の判定基準、ポン/ロンの手順、同時宣言の扱いなど)は [docs/rules.md](docs/rules.md) にまとめてある。

## ファイル構成

```
index.html               ロビー / 待機 / ゲーム画面(1ページ切替)
tests.html               自己検証 + 手札UIの手動確認
css/tokens.css           デザイントークン(hallmark 生成、Hum テーマを役割別に再チューニング)
css/style.css            スタイル
js/firebase-config.js    Firebase クライアント設定(公開情報。コミット可)
js/cards.js              120枚の定義、山札生成、シャッフル、layout→言葉分割
js/game-logic.js         ルールエンジン(Firebase/DOM 非依存の純粋関数)
js/hand-ui.js            手札レイアウト編集コンポーネント(DOM のみ)
js/app.js                Firebase 接続・部屋・購読・トランザクション・描画
js/tests.js              テスト(node js/tests.js / tests.html)
docs/rules.md            裁定表(役の判定・ポン/ロンの手順)
firestore.rules          Firestore セキュリティルール
firebase.json .firebaserc
.github/workflows/deploy-firestore-rules.yml  rules 変更時に自動デプロイ
```

## 設計メモ

### データ構造(Firestore `rooms/{code}` 1ドキュメント)

```js
{
  code, hostUid, status: 'lobby'|'playing',
  settings: { mode: 'basic'|'advanced', openHands: bool, claimSeconds: number },
  players: { [uid]: { name, wins, joinedAt } },
  order: [uid...],            // 席順。手番はこの index で回す
  round: {
    no, turnIndex, phase: 'draw'|'discard'|'claim'|'declare'|'result',
    deck: [id],               // 先頭から引く
    hands: { [uid]: { layout: [id|'_'], melds: [{ cards: [id,id,id], from }] } },
    discards: { [uid]: [id] }, lastDiscard: { uid, cardId, at }|null,
    claim: { passed: [uid], deadline }|null,
    declaration: { uid, type: 'tsumo'|'ron', cardId?, fromUid? }|null,
    winner, drawnCard, version
  }
}
```

- `layout` が手札の唯一のソース。`'_'` がスペースで、カード = layout から `'_'` を除いたもの
- `melds` は「配列の配列」が Firestore に置けないため `{ cards: [...] }` の配列

### 同期

- ゲーム操作は `runAction('関数名', ...args)`: `runTransaction` 内で doc を読み `GameLogic[関数名](room, uid, ...)` を適用して書き戻す。競合(ポン vs ツモ など)は Firestore のトランザクションが解決する
- 自分の手札の並びだけはトランザクションなしで `round.hands.{uid}.layout` を 400ms デバウンスで更新。**操作前に必ず `flushLayout()`** を呼ぶ(古い並びで上書きされるのを防ぐ)
- 手札は本来「全員に見える」ゲームなので DB 上に全員分ある。非公開設定はクライアント側で伏せるだけ(信頼ベース)。山札の順序も DB 上では見える

## セットアップ

Firebase プロジェクト `hiragajan-online` は作成済み。別プロジェクトで動かす場合:

1. Firebase コンソールでプロジェクト作成 → Authentication で「匿名」を有効化 → Firestore を作成
2. プロジェクトの設定 > マイアプリ(ウェブ)の設定値を `js/firebase-config.js` に貼る
3. `firestore.rules` を適用(`firebase deploy --only firestore:rules`、または下記の GitHub Actions で自動適用)

## ローカルで動かす

Firebase SDK を CDN から読むため `file://` では動かない。ローカルサーバー経由で開く。

```bash
npx serve .
```

表示された URL を 2〜8 タブ(またはスマホ)で開き、片方で部屋をつくって片方でコードを入れる。ロジックだけなら:

```bash
node js/tests.js
```

## GitHub Pages で公開

このリポジトリは `main` ブランチに push 済み。GitHub 側であと1回だけ設定が要る:

1. リポジトリの **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」、**Branch** を `main` / `/ (root)` にして Save
3. 数分後に `https://mkt918.github.io/hiragajan-online/` で公開される

## Firestore ルールの自動デプロイ(ユーザー実機での作業が必要)

`.github/workflows/deploy-firestore-rules.yml` は `firestore.rules` 等が変更されたときに自動で `firebase deploy --only firestore:rules` を実行する。これには GitHub Actions の Secret `FIREBASE_TOKEN` が要るが、**OAuth ログインを伴うため Claude では代行できない**。初回だけ、お使いの PC のターミナルで以下を実行してほしい。

```bash
npm install -g firebase-tools   # 未インストールの場合
firebase login:ci               # ブラウザが開くのでログインし、表示されたトークンをコピー
```

表示されたトークンを、GitHub リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で `FIREBASE_TOKEN` として登録すれば、以後は `firestore.rules` を変更して push するだけで自動反映される。トークンさえ登録すれば以降は完全自動(この手順は最初の1回だけでよい)。

登録しない場合でも、手動で `firebase deploy --only firestore:rules`(この PC で `firebase login` 済みなら Claude 側からも実行可)すれば同じ結果になる。

## 今後決めること

- 切断検知(Firestore に onDisconnect は無い。必要なら Realtime Database のプレゼンス、または `lastSeenAt` ハートビート + ホストの手番スキップ)
- 古い部屋の掃除(Firestore の TTL ポリシーを `createdAt` に設定)
- 山札の順序が DB 上で見える点をどこまで気にするか
- 同時にポン/ロンが宣言された場合の裁定はトランザクションの到達順(通信の速さ)で決まる。厳密な優先順位付け(ロン優先など)が必要ならルール調整が要る
