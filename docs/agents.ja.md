[English](agents.md) | **日本語**

# ai& のコーディングエージェント

[README](../README.ja.md#対応エージェント)の表にあるエージェントごとの詳細です。

どのエージェントでも、使えるコマンドは共通です。

| コマンド | 内容 |
| --- | --- |
| `aiand <agent>` | エージェントを ai& で開く。接続が未設定なら、先に設定する |
| `aiand <agent> on` | エージェントの接続を恒久的に設定し、通常のコマンドでも ai& を使うようにする |
| `aiand <agent> status` | エージェントが実際に使っている接続先を表示する |
| `aiand <agent> off` | aiand が追加した内容だけを削除する |
| `aiand run-agent <agent>` | 1 回のセッションだけ ai& を使い、エージェントの設定には何も書き込まない |
| `aiand restore <agent> --force` | エージェントの設定を、aiand が最初に変更する前の状態にバイト単位でそのまま戻す |

この表に当てはまらないエージェントが 3 つあります。GitHub Copilot アプリはデスクトップアプリでセッション起動の機能がないため、`aiand run-agent copilot-app` は使えません(「GitHub Copilot app does not support session launches」というエラーで止まります)。接続するには `aiand copilot-app on` を使います。Jouzu にもセッション起動の機能はありません。一時的な設定を指すための設定がセッションの保存場所も移動してしまうためです。`aiand run-agent jouzu` も同じように止まるので、`aiand jouzu` または `aiand jouzu on` で接続してください。また、`aiand codex on` を実行しても、通常の `codex` が ai& を使うようにはなりません。別のプロファイルを書き込むだけなので、Codex は `codex --profile aiand`(または `aiand codex`)で起動してください。詳しくは [Codex](#codex)、[GitHub Copilot アプリ](#github-copilot-アプリ)、[Jouzu](#jouzu) を参照してください。

`aiand code` は、既定のエージェントである OpenCode を開きます。`aiand init` は、インストール済みのエージェントを検出して、まとめて接続を設定します(`--all` で検出したすべてのエージェント、`--off` で解除)。

## `aiand <agent>` の動作

- サインインしていない場合、aiand がサインインするか確認します(ターミナルでのみ。先に確認します)。
- エージェントがインストールされていない場合、インストールコマンドが npm によるものなら、aiand が `aiand <agent> --help` に表示されるインストールコマンドを実行するか確認します。それ以外のインストール方法は、確認せずに表示するだけです。確認できるターミナルがない場合、aiand は何もインストールしません。インストールコマンドを表示して、終了コード `127` で終了します。
- エージェントの接続が未設定の場合、aiand は `on` を実行します。そのため、以降は通常の `opencode`、`codex --profile aiand`、`pi`、`omp`、`copilot`、`hermes` でも ai& が使われます。通常の `jouzu` でも以降は ai& を選べますが、最後に使ったモデルやプロジェクトのモデルがある場合は、そのモデルで起動します。`aiand jouzu` は ai& のモデルで起動します。何も変更しない `aiand run-agent <agent>` との違いはここです。ただし `aiand claude` は例外で、`aiand run-agent claude` と同じく 1 回のセッションだけを起動し、接続の設定はしません。
- エージェント名のあとの引数は、入力したとおりにエージェントへ渡されます(たとえば `aiand claude -p "explain this repo"`)。aiand 自身のフラグはエージェント名の前に置きます(`aiand --profile work codex`)。aiand が動詞(サブコマンド)と解釈してしまう引数の前には `--` を置きます(`aiand opencode -- status`)。
- `on` には、モデルを選ぶ `--model <id>` と、エージェント自身の既定のモデルをそのままにする `--model native` を指定できます。ただし `--model native` は、Codex と Claude Code 以外のエージェントで使えます。Codex は `native` を受け付けません。プロファイルが、ゲートウェイが提供できない `config.toml` のモデルを引き継いでしまうためです。`aiand claude on --model native` は、Claude Code の接続先をゲートウェイに向けますが、Claude Code 自身のモデルの選択はそのまま残るため、ai& が提供していないモデルへのリクエストが失敗することがあります(aiand は警告を表示します)。Claude Code には `--model <id>` を指定してください。
- エージェントは、絶対パスのエントリだけを含む `PATH` で起動します。空、`.`、相対パス(`./node_modules/.bin` など)のエントリは除外されます。これらは今いるフォルダーを指すため、クローンしたリポジトリに置かれたプログラムがエージェントから実行される恐れがあるためです。エージェントが使うツールは絶対パスで指定してください。
- API キーがローテーションされると、aiand が接続済みのエージェントを更新します。そのため、もう一度 `on` を実行しなくても使い続けられます。更新するのは、キーと同じ API エンドポイントに接続されているエージェントのうち、置き換えられたキーをまだ保持しているものだけです。別のエンドポイントに接続されているエージェント(接続先を aiand が判断できないものを含む)は元のキーのままで、aiand はそのエージェントを移すための `aiand --profile <name> <agent> on` コマンドを表示します。

エージェントの CLI は、各ベンダーのものです。インストールコマンドとドキュメントは次のとおりです。[OpenCode](https://opencode.ai)、[Claude Code](https://code.claude.com/docs)、[Codex](https://developers.openai.com/codex/cli)、[Pi](https://pi.dev)、[Oh My Pi](https://omp.sh)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/get-started/cli-quickstart)、[GitHub Copilot アプリ](https://github.com/features/ai/github-app)、[Hermes Agent](https://hermes-agent.nousresearch.com/docs/)(Nous Research)、[Jouzu](https://github.com/shisa-ai/jouzu)(Shisa AI)。

## OpenCode

```bash
aiand opencode           # OpenCode を ai& で開く。必要なら先に接続を設定する
aiand opencode on        # OpenCode を ai& 経由にする
aiand opencode status    # OpenCode が実際に使っている接続先を確認する
aiand opencode off       # aiand が追加した内容だけを削除する
aiand run-agent opencode # または: 1 回のセッションだけ ai& を使い、何も変更しない
```

`on` は、ライブのカタログにあるモデルとともに、`aiand` プロバイダーを `~/.config/opencode/opencode.json` に追加します。以降は、通常の `opencode` でも ai& が使われます。ほかのプロバイダーやご自身の編集はそのまま残ります。すでにモデルを選んでいる場合は、そのモデルが維持されます。切り替えるには `--model <id>` を指定し、OpenCode 自身の既定のモデルを使い続けるには `--model native` を指定します。OpenCode がタイトルや要約に使う `small_model` にも同じ ai& のモデルが設定されるため、OpenCode がほかのモデルを選ぶことはありません。ご自身の `small_model` は `off` で元に戻ります。`aiand opencode` は、その実行に限って、引き続き ai& のモデルで開きます。

`off` は、aiand が書き込んだ内容だけを削除します。設定が望ましくない状態になった場合は、`aiand restore opencode --force` で、aiand が最初に変更する前のファイルにそのまま戻せます。

`aiand run-agent opencode` は、各モデルが公開している推論レベルをセッションに書き込みます。GLM-5.3 では low、high、max が使えます。`aiand opencode on` は、同じレベルをすでにゲートウェイからコピーしています。

## Claude Code

```bash
aiand claude             # Claude Code のセッションを 1 つ ai& で開く。接続の設定はしない
aiand claude on          # すべての claude を ai& 経由にする
aiand claude status
aiand claude off         # Anthropic のモデルに戻す
```

`on` は、`env` ブロックを `~/.claude/settings.json`(または `$CLAUDE_CONFIG_DIR/settings.json`)に書き込みます。内容は、ゲートウェイの URL、API キー、そしてすべてのスロットに割り当てるカタログのモデルです。Claude Code は複数のスロットからリクエストを送ります。セッションのタイトルなどのバックグラウンドの処理は `haiku` スロットに、自動モードの安全チェックは Sonnet スロットに送られます。モデルを選んだ場合(`--model <id>` または `aiand config set model <id>`)は、`haiku` スロットも含めてすべてのスロットにそのモデルが割り当てられ、Claude Code はほかのモデルにリクエストを送りません。自動モードの安全チェックも同じです。`on` は `CLAUDE_CODE_AUTO_MODE_MODEL` も書き込むため、シェルで設定した値で安全チェックの送り先が変わることはありません。バックグラウンドの処理と安全チェックに別のモデルを使うには `--fast-model <id>` を追加します。もう一度 `on` を実行しても、また `aiand claude` のセッションでも、`--model` で選んだモデルは維持されます。プロファイルのモデルは、変更されればそれに従います。モデルを選ばなかった場合は、メインのスロットにビジョン対応のモデル、`haiku` スロットに高速なモデルが、aiand の優先順位から割り当てられます。`aiand claude --model <id>`(1 回のセッション)も、そのセッションで同じように動作します。`aiand claude status` は、すべてのスロットのモデルを表示し、選んだモデルと異なるモデル(手で設定したものなど)を持つスロットがあれば警告します。ai& が提供できない `model` 設定は `off` まで退避されます。提供できるものはそのまま残り、Claude Code はそのモデルで起動します。

`on` が変更するその他の内容:

- **コンテキストサイズ。** Claude Code のコンテキストの上限(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`)には、Claude Code が起動時に使うモデルについて ai& のカタログが公開している `context_window` が、1M を超える場合もそのまま設定されます。起動時のモデルとは、選んだモデル、残された `model` 設定、または `aiand claude --model haiku` のようなエイリアスが指すスロットのモデルです。`--fast-model` はこの値を変えません。Claude Code はプロセスごとに上限を 1 つしか持たないため、`/model` でモデルを切り替えても、セッションは起動時のモデルの上限のままです。別のモデルで作業するには、いったん終了して `aiand claude --model <id>` で新しいセッションを始めるか、`claude` を起動する前に `aiand claude on --model <id>` を実行してください。`[1m]` の接尾辞が付いたモデルも、1M と仮定せずカタログの値で上限が決まるよう、`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` は設定したままにします。Claude Code が Claude のモデルとして認識する ID には、Claude Code 自身の上限が使われる場合があります。詳しくは [コンテキストの上書きのルール](https://code.claude.com/docs/en/model-config#which-ids-claude_code_max_context_tokens-applies-to) をご覧ください。
- **Attribution ヘッダー。** 無効にします。有効なままだと、ai& がこれをプロンプトのテキストとしてモデルに渡してしまうためです。
- **`/model`。** ai& のすべてのモデルを一覧表示します。Claude Code がゲートウェイから見つけるのは、ID に "claude" を含むモデルだけです。そのため `on` は、モデルを `modelPicker` 設定に書き込み、組み込みの Opus、Sonnet、Haiku の行を置き換えます(ご自身で設定した `modelPicker` は、そのまま残ります)。各行には、モデルが公開しているコンテキストサイズ(`ai& · 1M context`)が表示されます。テキストのみのモデルには `· text only` が付きます。
- **ほかのクラウド。** Bedrock、Vertex、Foundry のスイッチは `0` で書き込まれます。ほかの場所でオンのままになっていても、Claude Code が ai& 以外へ向かうことはありません。
- **自動モードの安全性チェック。** 自動モード(Claude Code の既定の権限モード)では、Claude Code はチェック対象の操作ごとに、その操作が安全かどうかをモデルに問い合わせます。1 回のチェックで約 30,000 の入力トークンが送られ、メインのモデルで実行すると、コーディングの作業よりも費用がかかります。`on` は `CLAUDE_CODE_AUTO_MODE_MODEL` で、このチェックを高速なモデルに向けます(Claude Code 2.1.302 以降。それより前のバージョンはこの設定を無視し、メインのモデルを使います)。また `CLAUDE_CODE_AUTO_MODE_SERVER=0` を設定し、Claude Code が常に自分でチェックを実行するようにします。Anthropic がサーバー側で行うチェックには Claude のモデルが必要です。この設定がないと、Claude Code はサーバー側のチェックを求めてからフォールバックし、今後のリリースではチェック対象の操作をすべて確認または拒否するようになる、という通知を表示します。詳しくは [ADR 2](adr/0002-claude-auto-mode-safety-checks.md) をご覧ください。
- **WebSearch** は、Anthropic のサーバーで実行されるため拒否されます。WebFetch は引き続き使えます。
- **`/effort`** は、モデルの推論レベルとして ai& に送られます。そのため、モデルが公開しているレベルを選んでください。`moonshotai/kimi-k3` では `low`、`high`、`max` が使え、それ以外のレベルは拒否されます。

Claude Code をつないでいる間、API キーはこのファイルに保存されます。dotfiles のリポジトリに含めないでください。Claude Code は、`env` の値すべてと同様に、実行するすべてのコマンドとフックにこのキーを渡します。プロジェクト自身の `.claude/settings.json` で、これらの値を上書きすることもできます。

`off` は、aiand が書き込んだ内容を削除し、退避していた `model` を元に戻します。これにより、Claude Code は再びご自身のサインインと Anthropic のモデルを使います。

## Codex

```bash
aiand codex              # Codex を専用の ai& プロファイルで開く。必要なら先にプロファイルを書き込む
aiand codex on           # Codex 用の ai& プロファイルを書き込む
codex --profile aiand    # そのあと、Codex を ai& で起動する
aiand codex status
aiand codex off
aiand run-agent codex    # Codex を ai& で起動する。何も書き込まない
```

`on` は、別のプロファイル `~/.codex/aiand.config.toml`(または `$CODEX_HOME/aiand.config.toml`)を書き込み、`config.toml` には触れません。そのため、通常の `codex` はこれまでの設定のままで、`codex --profile aiand` で ai& を使います。プロファイルの使用中も `config.toml` は読み込まれるので、その MCP サーバーとプラグインも引き継がれます。

- **プロファイルにキーは入りません。** Codex は、現在有効な aiand のプロファイルに対して `aiand key export` を実行します。そのため、キーのローテーションや `aiand config use` のあとも何もする必要はありません(`on --profile <name>` を指定すると、代わりに別のプロファイルに固定されます)。Windows では、`aiand.cmd` のシムではなく、このインストールの Node と `dist\index.js` を直接実行します。シムは、Codex の作業ディレクトリで `node` を探してしまうためです。
- **推論とツール。** モデルが公開している推論レベルに固定します。Plan Mode でも同様です。また、ai& が実行しない Codex のホスト型ツール(Web 検索、画像生成など)を無効にします。
- **ご自身の変更は残ります。** Codex の `/model` で選んだモデルやレベルは、もう一度 `on` を実行しても維持されます。切り替えるには `--model <id>` を指定します。プロファイル内にあるご自身の設定は、`on` と `off` のあとも残ります。
- **競合。** `on` は、すでに Codex を別の接続先に向けているプロファイルを拒否します。`--force` を付けると上書きでき、`aiand restore codex --force` で元のプロファイルに戻せます。

ai& で使える Codex のバージョンと、バージョン間の変更点は、[Codex ガイド](https://docs.aiand.com/integrations/codex/)にあります。

## Pi

```bash
aiand pi                 # Pi を ai& で開く。必要なら先に接続を設定する
aiand pi on              # Pi を ai& 経由にする
aiand pi status
aiand pi off
aiand run-agent pi       # または: 1 回の Pi セッションを ai& で実行。Pi の設定には何も書き込まない
```

`on` は、ゲートウェイの OpenAI 互換の形式で通信する `aiand` プロバイダーを、ライブのカタログにあるすべてのモデルとともに `~/.pi/agent/models.json` に書き込みます。セッションのキーは `~/.pi/agent/auth.json`(ご自身だけが読めます)に保存し、`~/.pi/agent/settings.json` に `defaultProvider`/`defaultModel` を設定します。ほかのプロバイダーと認証情報には触れません。ai& が提供できない `defaultModel` は `off` まで退避されます。提供できるものはそのまま残ります。切り替えるには `--model <id>` を指定し、Pi 自身の既定のモデルをそのままにするには `--model native` を指定します。

Pi は、各モデルが公開している推論レベルを選択肢として表示します。モデルが公開していないレベルは表示されません。Pi 自身の既定は medium です。medium がモデルの一覧にない場合、Pi はモデルが公開している次のレベルに上げます。GLM-5.3 では、それは high です。

Pi の設定のルートは、`PI_CODING_AGENT_DIR` でまとめて移動できます。

## Oh My Pi

```bash
aiand omp                # Oh My Pi を ai& で開く。必要なら先に接続を設定する
aiand omp on             # Oh My Pi を ai& 経由で接続する
aiand omp status
aiand omp off
aiand run-agent omp      # または: 1 回の Oh My Pi セッションを ai& で実行。omp の設定には何も書き込まない
```

`on` は、上書き専用の `aiand` プロバイダーブロックを `~/.omp/agent/models.yml` に書き込み(omp はすでに aiand プロバイダーを同梱しているため、書き込むのはゲートウェイの URL、API キー、所有者を示すマーカーだけです)、`~/.omp/agent/config.yml` の `modelRoles.default` を固定します。ほかのプロバイダーと設定には触れません。ai& が提供できない `modelRoles.default` は `off` まで退避されます。提供できるものはそのまま残ります。切り替えるには `--model <id>` を指定し、omp 自身の既定のモデルをそのままにするには `--model native` を指定します。`PI_CODING_AGENT_DIR` は設定のルートをまとめて移動し、`PI_CONFIG_DIR` は `.omp` ルートの名前を変更します。

1 回のセッションだけの起動では、セッション履歴は omp 自身のセッションディレクトリに保存されます。`omp config init-xdg` で omp を移行している場合は、XDG の場所(`$XDG_DATA_HOME/omp/sessions`)です。

## GitHub Copilot CLI

```bash
aiand copilot            # Copilot CLI を ai& で開く。必要なら先に接続を設定する
aiand copilot on         # GitHub Copilot CLI を ai& 経由で接続する
aiand copilot status
aiand copilot off
aiand run-agent copilot  # または: 1 回の Copilot CLI セッションを ai& で実行。設定には何も書き込まない
```

`on` は、ライブのカタログにあるすべてのモデルとともに、`aiand` プロバイダーを `~/.copilot/providers.json`(または `$COPILOT_HOME/providers.json`)に書き込み、`~/.copilot/settings.json` に `aiand/<id>` のモデルを固定します。これは、`copilot` をそのまま起動するために必要です。BYOK のプロバイダーには、組み込みの既定のモデルがないためです。ほかのプロバイダーとその行には触れません。プロバイダーの行にはセッションのキーそのものが入るので、GitHub のサインインは関係しません。モデルを切り替えるには `--model <id>` を指定します。`off` は、置き換えられた `model` の選択を元に戻すか、追加したキーを削除します。そのあいだにご自身で変更した値は残します。Copilot をつないでいる間、キーはこのファイルに保存されるので、dotfiles のリポジトリに含めないでください。`--model native` を指定すると、settings.json のモデルはそのままになります。

## GitHub Copilot アプリ

デスクトップアプリでは、アプリ自身のプロバイダーストアを通じて、同じ接続を設定できます。それ以外は何も変更しません。`aiand copilot-app on` は、`aiand-` で始まるプロバイダーの行と、カタログのモデルごとに 1 行のモデルの行を、`~/.copilot/data.db`(または `$COPILOT_HOME/data.db`)に書き込みます。このデータベースはアプリが作成したものである必要があるため、先に一度アプリを開いてください。アプリは BYOK のプロバイダーでも GitHub のサインインを維持します。ai& のモデルは、アプリ自身のモデルメニューで選びます。aiand は、そこで既定のモデルを設定しません。

`on` や `off` の前にアプリを終了してください。アプリは終了時にデータベースを書き換えるため、変更が上書きされてしまいます。`--force` を付けると、そのまま実行します。アプリは GUI なので、`run-agent copilot-app` はありません。`aiand copilot-app` だけを実行すると、アプリの接続を設定し、アプリの開き方を案内します。aiand は GUI アプリを起動できず、`copilot-app` のあとに何か続けるとエラーになります。

## Hermes Agent

```bash
aiand hermes             # Hermes を ai& で開く。必要なら先に接続を設定する
aiand hermes on          # Hermes を ai& 経由にする
aiand hermes status
aiand hermes off
aiand run-agent hermes   # Hermes を 1 回のセッションだけ ai& で起動する。何も書き込まない
```

`on` は、専用の `aiand` モデルプロバイダーを `model-provider` プラグインとして `~/.hermes/plugins/model-providers/aiand` に配置し、`~/.hermes/config.yaml` に `providers.aiand` ブロックを追加し、専用の名前でAPI キーを `~/.hermes/.env`(モード 0600)に書き込みます。`.env` を読み込んだあと、キーは Hermes 自身のプロセスの中に存在しますが、Hermes が実行するツールには渡りません。生成されたプロバイダーが変数を宣言しており、これが Hermes のプロバイダー環境変数のブロックリストに反映されるため、ターミナルとツールの子プロセスはキーなしで起動されます。

- **推論レベル。** 生成されたプロバイダーには、各モデルが公開しているレベルが含まれます(GLM-5.3 では low、high、max が使えます)。標準のインストールではレベルが未設定のため、`reasoning_effort` は送られず、ゲートウェイのモデルごとの既定が適用されます。ご自身で選んだレベルは、公開されているレベルの範囲に丸められます。
- **モデル。** トップレベルのモデルは、ライブのカタログから固定されます。切り替えるには `--model <id>` を指定し、model セクションをそのままにするには `--model native` を指定します(Hermes は送信する既定のモデルを必要とするため、ai& が既定のモデルを削除することはありません)。
- **ご自身のエントリ。** ほかのプロバイダー、プラグイン、セッション、編集内容には触れません。`~/.hermes/.env` にあるご自身の `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_TOKEN` は、その場所でコメントアウトされ(`# aiand set aside: …`)、`off` でコメントが解除されます。

`off` は、aiand が書き込んだ内容だけを削除します。設定が望ましくない状態になった場合は、`aiand restore hermes --force` で、aiand が最初に変更する前のファイルにそのまま戻せます。

`run-agent` は、事前に `on` を実行しなくても、1 回のセッションを一時的な `HERMES_HOME` オーバーレイ経由にします。セッション、スキル、メモリ、ログ、ご自身のプラグインは、シンボリックリンクで元の場所につながるため、ネイティブのまま再開できます。一方、認証情報はオーバーレイの中にしか存在せず、`config.yaml` を含む実際の `~/.hermes` には書き込まれません。オーバーレイには同じ専用の `aiand` モデルプロバイダーが入り、その `config.yaml` はライブのカタログからモデルを固定します。選ぶには `--model <id>` を使ってください(セッションの起動では必ずモデルが指定されるため、`--model native` は通常のカタログのエラーになります)。`--` のあとの引数にある `--model` または `-m` は `--model` として扱われ、セッションはそのモデルで動きます。`--provider` は取り除かれるので、注入された接続先を上書きすることはできません。オーバーレイは、セッションの終了後(成功、失敗、Ctrl-C のいずれでも)に削除されます。

## Jouzu

```bash
aiand jouzu              # Jouzu を ai& で開く。必要なら先に接続を設定する(aiand jz でも可)
aiand jouzu on           # Jouzu を ai& 経由にする
aiand jouzu status
aiand jouzu off
```

Jouzu は、Shisa AI が Pi をもとに作ったターミナル向けのコーディングハーネスです。Pi のファイルを Jouzu 自身の設定ディレクトリに置くため、`on` は `aiand pi on` と同じ `aiand` プロバイダー、認証情報(ご自身だけが読めます)、`defaultProvider`/`defaultModel` を、Jouzu の `agent` ディレクトリに書き込みます。場所は、macOS では `~/Library/Application Support/Jouzu/agent`、Linux では `$XDG_CONFIG_HOME/jouzu/agent`(既定は `~/.config/jouzu/agent`)、Windows では `%APPDATA%\Jouzu\agent`、`JOUZU_HOME` を設定している場合は `$JOUZU_HOME/agent` です。Pi 自身の `~/.pi` には触れません。Shisa のサインインやほかのプロバイダーもそのまま残ります。`off` は aiand が書き込んだ内容だけを削除し、`aiand restore jouzu --force` で、aiand が最初に変更する前のファイルにそのまま戻せます。

Jouzu は、`defaultModel` よりも先に、プロジェクトの既定のモデルまたは最後に使ったモデルで起動します。そのため `aiand jouzu` は、その起動に限り `--provider aiand --model <id>` を追加します。ただし、引数ですでにモデル、セッション、Jouzu のコマンドを指定している場合は追加しません。セッションの中では、通常どおり `/model` で切り替えられます。`--model native` を指定すると、Jouzu 自身の選択がそのまま使われます。署名済みの Windows ランチャーは設定を別の場所に置くため、`on` の前に `JOUZU_HOME` をそのデータディレクトリに設定してください。`run-agent jouzu` はありません。`JOUZU_HOME` は Jouzu のセッションと状態も移動するため、1 回のセッション用のオーバーレイでは履歴が見えなくなってしまうためです。

Jouzu は、ai& が管理していないサードパーティのソフトウェアです。ai& のデータの保管場所と保持期間に関する約束が対象とするのは、ai& の API が受け取るデータだけです。Jouzu 自身がお使いのマシンで保存、送信、実行する内容は対象外です。
