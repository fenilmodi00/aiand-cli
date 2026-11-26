<img src="docs/assets/aiand-cli-logo.svg" alt="ai&amp; CLI logo" width="480">

[English](README.md) | **日本語**

**Less setup. More building.**

`aiand` は ai& の推論 API を使うためのコマンドラインツールです。ブラウザでサインインし、そのあとで Claude Code、OpenCode、Codex などのコーディングエージェントを ai& につなぎます。プロキシやデーモンは使いません。プロンプトの送信、モデルと料金の一覧表示、リクエストと使用量の確認もできます。

ガイド: [docs.aiand.com/ja/cli](https://docs.aiand.com/ja/cli/)

## クイックスタート

1. **インストールします。** Node.js 22 以降が必要です。

   macOS と Linux:

   ```bash
   curl -fsSL https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.sh | bash
   ```

   Windows (PowerShell):

   ```powershell
   irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1 | iex
   ```

   インストーラーは PowerShell 7 でも Windows PowerShell 5.1 でも動作します。この README のそのほかの PowerShell コマンドは PowerShell 7(`pwsh`)向けです。詳しくは[更新とアンインストール](#更新とアンインストール)を参照してください。

   どの OS でも `npm install -g @aiand/cli` でインストールできます。

2. **サインインします。** インストーラーの最後にサインインするか聞かれます。あとで行う場合は次のコマンドを実行します。

   ```bash
   aiand login
   ```

3. **エージェントを ai& で開きます。**

   ```bash
   aiand claude    # Claude Code
   aiand code      # OpenCode
   ```

   ほかのエージェントは[対応エージェント](#対応エージェント)を参照してください。エージェントを使わない場合は `aiand run "hello"` を試してください。

インストール後に `aiand` が見つからない場合は、新しいターミナルを開いてください。

## 対応エージェント

ai& CLI は次のコーディングエージェントで使えます。

| エージェント | コマンド | `on` コマンドが変更するもの |
| --- | --- | --- |
| [OpenCode](https://opencode.ai) | `aiand opencode` または `aiand code` | `~/.config/opencode/opencode.json` に `aiand` プロバイダーを追加 |
| [Claude Code](https://code.claude.com/docs) | `aiand claude` | `~/.claude/settings.json` に `env` ブロックを書き込み |
| [Codex](https://developers.openai.com/codex/cli) | `aiand codex` | 別のプロファイル `~/.codex/aiand.config.toml` を作成。`codex --profile aiand` で起動 |
| [Pi](https://pi.dev) | `aiand pi` | `~/.pi/agent/models.json` にプロバイダー、`auth.json` にキー、`settings.json` に既定値を追加 |
| [Oh My Pi](https://omp.sh) | `aiand omp` | `~/.omp/agent/models.yml` と `config.yml` を書き込み |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/get-started/cli-quickstart) | `aiand copilot` | `~/.copilot/providers.json` にプロバイダーを追加し、`settings.json` にモデルを設定 |
| [GitHub Copilot アプリ](https://github.com/features/ai/github-app) | `aiand copilot-app` | `~/.copilot/data.db` にプロバイダーの行を書き込み。aiand は接続の設定だけを行い、アプリは自分で開きます |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) | `aiand hermes` | `~/.hermes/plugins/` にプロバイダープラグインを追加し、`config.yaml` と `.env` を変更 |
| [Jouzu](https://github.com/shisa-ai/jouzu) | `aiand jouzu` または `aiand jz` | Jouzu 自身の設定ディレクトリにある Pi の 3 つのファイル: `agent/models.json` にプロバイダー、`auth.json` にキー、`settings.json` に既定値を追加 |

`aiand <agent>` は、エージェントを ai& で開きます。必要ならサインインと接続の設定を先に行います。ただし `aiand claude` は例外で、1 回のセッションだけを起動し、接続の設定はしません([下の例](#例-claude-code-で-ai-を使う)を参照)。`aiand <agent> on` は、開かずに接続だけを設定します。`aiand <agent> off` は、aiand が追加した内容を削除します。`aiand <agent> status` は、エージェントが実際に使っている接続先を表示します。

- ほかのプロバイダーやご自身の編集はそのまま残ります。`off` は aiand が書き込んだ内容だけを削除します。`aiand restore <agent> --force` は、aiand が最初に変更する前のファイルに戻します。
- `aiand run-agent <agent>` は、1 回のセッションだけ ai& を使い、エージェントの設定には何も書き込みません。
- `aiand init` は、インストール済みのエージェントを検出して、まとめて接続を設定します(`--all` で検出したすべて、`--off` で解除)。
- エージェントがインストールされていない場合、インストールコマンドが npm によるものなら、aiand がインストールするか確認します。それ以外は、コマンドを表示して終了コード `127` で終了します。
- エージェント名のあとの引数は、入力したとおりにエージェントへ渡されます。aiand 自身のフラグはエージェント名の前に置きます(`aiand --profile work codex`)。aiand がサブコマンドと解釈してしまう引数の前には `--` を置きます(`aiand opencode -- status`)。
- API キーがローテーションされると、aiand が接続済みのエージェントを更新します。

詳細とエージェントごとの注意点: [docs/agents.ja.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/agents.ja.md)

## 例: Claude Code で ai& を使う

Claude Code で ai& を使う方法は 2 つあります。1 回のセッションだけ使う方法と、すべてのセッションで使う方法です。

### 1 回のセッションだけ使う

```bash
aiand claude                              # Claude Code のセッションを 1 つ ai& で開く
aiand claude -p "explain this repo"       # Claude Code に引数を渡す
aiand claude --model <id>                 # このセッションで使う ai& のモデルを選ぶ
```

`aiand claude` は Claude Code のセッションを 1 つ ai& で起動し、Claude Code の設定には何も書き込みません。ほかのターミナルで開いた通常の `claude` のセッションは、その前も最中もあとも、Anthropic のモデルを使い続けます。`claude` のあとに続く引数は、そのまま Claude Code に渡されます。ただし `--model <id>` は、このセッションのすべてのモデルのスロットで使う ai& のモデルを選びます。モデルの一覧は `aiand models` で確認できます。

`/model` で ai& のモデルを選んで既定として保存した場合、Claude Code が保存した直後に、aiand が元の既定のモデルに戻します。そのため、ai& のセッションがまだ開いているあいだに起動した通常の `claude` でも、使えるモデルで起動します。`aiand claude on` が有効なあいだは、すべての `claude` が ai& で動くため、ai& の既定のモデルはそのまま残ります。

### すべてのセッションで使う

```bash
aiand claude on                  # すべての claude を ai& 経由にする
claude                           # ai& を使う
aiand claude status              # Claude Code の現在の接続先を確認する
aiand claude off                 # Anthropic のモデルに戻す
```

- **`aiand claude on`** は、ゲートウェイの URL、API キー、モデルの設定を `~/.claude/settings.json`(または `$CLAUDE_CONFIG_DIR/settings.json`)に書き込みます。以降は、すべての `claude` が ai& を使います。モデルを選ぶには `--model <id>` を付けます。
- **すでに開いているセッションも切り替わります。** Claude Code は `on` と `off` を実行中のセッションにも反映します。`on` を実行するとすぐに ai& に切り替わり、`off` を実行すると元に戻ります。`off` は、実行中のセッションが設定を読み込み直すまで約 3 秒かかります。それでも ai& から応答するセッションは、`/exit` のあと `claude --continue` で開き直してください。
- **元に戻すには** `aiand claude off` を実行します。aiand が追加した内容だけを削除し、ご自身の編集は残します。`aiand restore claude --force` を実行すると、aiand が最初に変更する前のファイルにそのまま戻せます。

Claude Code をつないでいる間、API キーは `settings.json` に保存されます。このファイルを dotfiles のリポジトリに含めないでください。`on` が変更するその他の内容(コンテキストサイズ、`/model` の一覧、WebSearch)は [docs/agents.ja.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/agents.ja.md#claude-code) にあります。

## サインイン

`aiand login` はブラウザを開きます。承認すると、組織用のAPI キーが作成されます。キーには `aiand@<hostname>` というラベルが付くので、コンソールでどのマシンのキーか区別できます。SSH 経由で接続している場合や、ブラウザでのサインインを完了できない場合(ブラウザがない、タイムアウトした、ターミナルのないスクリプトなど)は、ブラウザを開かずにコードが表示されます。任意のデバイスからそのコードを承認してください。

```
  Your code   BCDF-GHJK
  Approve at  https://api.aiand.com/auth/device?user_code=BCDF-GHJK
```

コンソールで発行済みのAPI キーがある場合:

```bash
aiand login --paste                # マスクされた入力欄に貼り付ける
aiand login --with-token < key.txt # 標準入力から読み込む
```

`aiand logout` は、`login` が作成したキーを無効化するか確認します。無効化の要求が ai& に届かなかった場合はサインインしたままになるので、もう一度 `logout` を実行できます。`--keep-remote` を付けると、キーを無効化せずにこのマシンからだけ削除します。貼り付けたキーはこのマシンから削除されるだけです。[コンソール](https://console.aiand.com/api-keys)で無効化してください。

もう一度サインインする(`aiand login --force` を実行するか、「Sign in again and replace it?」に yes と答える)と、新しいサインインを保存したあとで、以前のサインインが作成したキーを無効化します。新しいサインインを保存する前にサインインに失敗した場合や中断した場合は、以前のサインインが残ります。保存したあとの処理が失敗した場合も、古いキーは無効化します。無効化の要求が ai& に届かなかった場合も新しいサインインはそのまま有効で、aiand がその旨を表示します。コンソールで古いキーを無効化してください。`--keep-remote` を付けると、古いキーを有効なまま残します。貼り付けたキーは無効化しません。

キーには有効期限があります。aiand は期限の最後の 3 日間に自動でローテーションし、サーバーがキーを拒否した場合はすぐにローテーションします。

**CI とスクリプト:** `login` は不要です。`AIAND_API_KEY` を設定してください。ディスクには何も書き込まれません。

## API キーの保存場所

`aiand status` で、どれが使われているか確認できます。

| OS | 保存場所 | 防げるもの |
| --- | --- | --- |
| macOS | キーチェーン | マシン上の他のアカウント、およびファイルを別の場所にコピーされること |
| Linux | `secret-tool` 経由の Secret Service(GNOME Keyring、KWallet) | 同上。ログイン時にキーリングのロックが解除されている場合 |
| Windows | DPAPI(Windows に付属の Windows PowerShell 経由)。暗号化されたキーは `%USERPROFILE%\.config\aiand\` にあります | 他の Windows アカウント、およびファイルを別のマシンやアカウントにコピーされること |

ご自身の権限で動くプログラムからは、いずれの方法でもキーを守れません。

これらのどれも使えない場合(キーリングのないヘッドレスな Linux、PowerShell が制約付き言語モード (Constrained Language Mode) で動作する Windows など)は、キーが `~/.config/aiand/` 以下のファイルに保存されます。復号用のキーがそのファイルのすぐ隣にあるため、`aiand status` では `file (owner-only, not encrypted at rest)` と表示されます。ちょっとした閲覧は防げますが、そのフォルダーを読める人は防げません。Windows では、DPAPI を使えなかった理由も `aiand status` に表示されます。

<details>
<summary>キーの保存についての補足</summary>

- `AIAND_KEY_STORAGE` で保存先を 1 つ指定できます。`keychain`(macOS と Linux のみ)、`dpapi`(Windows のみ)、`file`、`plaintext`(指定した場合にだけ使われる、所有者のみが読める平文ファイル)のいずれかです。`--json` の出力には、同じ ID の `storage_tier` が含まれます。
- `AIAND_SECRET_STORE_MASTER_KEY` でファイル形式の暗号鍵を自分で指定すると、フォルダーのコピーに対してファイルが保存時に暗号化されます。表示は `file (encrypted; key held outside the config folder)` になります。Windows で所有者のみのアクセス権(ACL)を設定できなかった場合(`icacls` が失敗した場合。理由は `AIAND_DEBUG=1` で確認できます)は、表示に `not owner-only` と付きます。
- Windows でファイル形式に保存されたキーは、aiand が次に読み込んだときに DPAPI に移ります。PowerShell に接続できない場合(応答しない、タイムアウトする、失敗する)は、キーはファイルに残り、`aiand status` がその理由を表示します。読み取りでは 10 分間再試行しないので、応答しない PowerShell の待ち時間は、`aiand` のプロセスごとではなく 1 回で済みます。次のサインインでは、すぐに DPAPI を試します。
- Windows で aiand をダウングレードする前に、`aiand logout` を実行してください。古いバージョンは、DPAPI に移ったキーを見つけられないため、サインアウトも revoke もできません。
- DPAPI のキーを読む `aiand` の実行ごとに、Windows PowerShell が 1 回起動します。起動直後のマシンでは少し時間がかかることがあります。エンドポイントセキュリティがこれをブロックする場合は、`AIAND_KEY_STORAGE=file` を設定して DPAPI を使わないようにしてください。

Windows 環境の多数のマシンに展開する場合のコスト、エンドポイントセキュリティの挙動、テスト計画: [docs/windows-key-storage.ja.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/windows-key-storage.ja.md)

</details>

## 共用 PC と貸出 PC

信頼の境界はオペレーティングシステムのアカウントです。同じアカウントにサインインできる人は、aiand が保存した内容を使えます。マシンを返却する前に、次のコマンドを実行してください。

```bash
aiand logout --all
```

実行前に確認が表示されます。ターミナルがない環境では `--force` を付けてください。このコマンドは次の処理を行います。

- このマシンで `login` が作成したすべてのキーを、プロファイルごとに無効化します。到達できなかったものはサインインを残すので、もう一度実行できます。
- どのプロファイルで接続したかにかかわらず、すべてのコーディングエージェントから ai& を削除し、設定ファイルに ai& のキーが残っていないか確認します。
- クラッシュした `aiand run-agent` が一時ディレクトリに残したセッションファイルを削除します。ただし、Hermes のシムがまだ指しているものは、削除すると `hermes` コマンドが動かなくなるため、削除せずに報告します。Hermes を再インストールしたあとで実行すると削除されます。
- 保存されているすべてのキー(OS のキーチェーンのエントリを含む)と、`~/.config/aiand` 自体(プロファイル、設定、スナップショット)を削除します。

CLI 自体も削除するには、インストーラーの `uninstall --purge` を実行します。先に同じサインアウト処理を行い、それが失敗した場合は何も削除しません。[アンインストール](#更新とアンインストール)を参照してください。

**貼り付けたキーはコンソールで無効化してください。** 貼り付けたキー(`--paste`、`--with-token`)は、CLI が作成したものではないため、CLI からは無効化できません。`logout --all` が一覧を表示します。[console.aiand.com/api-keys](https://console.aiand.com/api-keys) で無効化してください。無効化できなかったキーについても同様です。

そのあと、ほかのアカウントでコーディングエージェントを使っていた場合は、エージェント自体からもサインアウトしてください。

<details>
<summary><code>logout --all</code> が終了コード 1 で終わった場合</summary>

何も残らなかった場合は終了コード `0`、残ったものがあれば一覧を表示して `1` で終了します。

- 無効化できなかったキー。そのプロファイルのサインインと設定ディレクトリは残ります。キーを無効化できるのはリフレッシュトークンだけだからです。もう一度 `logout --all` を実行するか、`logout --all --keep-remote` でこのマシンからだけ削除して、コンソールで無効化してください。
- 読み取れなかった保存済みのサインイン(SSH 経由でロックされたキーチェーン、壊れた `credentials.json` など)。そのプロファイルのサインインのファイルと設定ディレクトリは残るため、再実行すればキーを無効化できます。キーチェーンのロックを解除するかファイルを直してから、もう一度 `logout --all` を実行してください。`uninstall --purge` もここで停止し、何も削除しません。
- 修正できなかったエージェントの設定(たとえば JSON として無効になっているもの)。そのエージェントの `snapshots/<agent>` フォルダーと設定ディレクトリは残ります。設定を直して `aiand <agent> off` を実行し、もう一度 `logout --all` を実行してください。
- まだ実行中のセッション。
- 設定ディレクトリ内にある、ご自身のファイル。これらはそのまま残します。

`--keep-remote` は、何も無効化せずにローカルのデータをすべて削除します。`--json` は各ステップの結果を出力します。

`logout --all` が削除する設定ディレクトリは、ホームディレクトリの中にあるものだけです。ほかの場所にある `AIAND_CONFIG_DIR` を削除するには、`AIAND_WIPE_OUTSIDE_HOME=1` を設定してください。また、aiand のものだと確認できるディレクトリだけを削除します。そのため、`AIAND_CONFIG_DIR` を誤って(たとえば `~/.docker` を)指定しても何も失われません。aiand は、ディレクトリに初めて書き込むときに `.aiand-config` ファイルを作成します。ただし、そのディレクトリが新規であるか、空であるか、aiand 自身のファイルしか含まない場合に限ります(`~/.docker` へのキャッシュの書き込みでは何も作成されません)。`.aiand-config` ファイルにはランダムな ID が入っていて、そのディレクトリの `config.json` にも同じ ID が記録されます。そのため、空のファイルや別の場所からコピーしたファイルでは確認を通りません。それ以前のディレクトリは、`config.json` に `profile` と `profiles` があれば確認を通ります。サインインのファイル(`credentials.json`、`secret-store.*`)は、そのような `config.json` が同じディレクトリにある場合にだけ削除されます。`.aiand-config` ファイルだけで確認を通るのはキャッシュだけです。確認できない場合は、何も触らずに終了します。本当に aiand のディレクトリであれば、`AIAND_CONFIG_DIR` をそのディレクトリに設定して `aiand login` を実行し、aiand にこれらを書き込ませてください。`config.json` に `.aiand-config` と異なる ID が記録されている場合は、先に `.aiand-config` を削除してください。aiand は ID の入った `.aiand-config` を書き換えません。そのディレクトリに `config.json` のないサインインがある場合(`config.json` を書き込む前に中断されたサインイン)は、先に `credentials.json` にある各プロファイルについて、そこで `aiand logout --profile <name>` を実行してください。キーは発行元で revoke されます。その上に `aiand login` を実行しても、古いキーは revoke されません。`config.json` がないディレクトリや、`config.json` の ID が `.aiand-config` と一致しないディレクトリでは、発行元を記録していないサインインはどこにも送信されません。コンソールでキーを revoke してから、`aiand logout --keep-remote` を実行してください。ディレクトリ内の `locks` と `snapshots` フォルダーでは、aiand が作成していないエントリは残されます。ディレクトリは、何かを削除する直前にもう一度確認されるため、revoke の最中にリンクへすり替えられたディレクトリは拒否されます。

</details>

## 更新とアンインストール

インストーラーは、CLI を `~/.aiand/cli` に、ランチャーを `~/.local/bin` に置きます。そのフォルダーを PATH に追加します。zsh は `~/.zshrc`、macOS の bash は `~/.bash_profile`、Linux の bash は `~/.bashrc` に、Windows ではユーザーの PATH に追加します。fish と nushell では、実行するコマンドが表示されます。この変更を行いたくない場合は `AIAND_NO_MODIFY_PATH=1` を設定してください。インストーラーの再実行や `update` は `~/.config/aiand` に触れないため、エージェントの接続はそのまま残ります。

> **PowerShell 7。** この README の PowerShell コマンドは PowerShell 7(`pwsh`)向けです。Windows PowerShell 5.1 にはセキュリティ修正しか提供されないため、Microsoft は PowerShell 7 のインストールを推奨しています。[Windows への PowerShell のインストール](https://learn.microsoft.com/ja-jp/powershell/scripting/install/install-powershell-on-windows)を参照してください(Windows PowerShell 5.1 も起動のたびに同じリンクである <https://aka.ms/PSWindows> を表示します)。これは、コマンドを入力するシェルについての話です。インストーラーは引き続き Windows PowerShell 5.1 で動作するため、ワンライナーの `irm … | iex` はどちらのシェルでも使えます。また、aiand 自身は DPAPI を利用するために、Windows に付属の Windows PowerShell 5.1 を使います。

**更新。** 新しいバージョンが出ると、ターミナルでお知らせが表示されます(表示しない場合は `AIAND_UPDATE_CHECK=0` を設定してください)。npm でインストールした場合は `npm install -g @aiand/cli@latest` を実行します。インストーラーを使った場合は次のとおりです。

```bash
bash ~/.aiand/cli/install.sh update
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update
```

`-ExecutionPolicy Bypass` はその PowerShell プロセスだけに適用されるため、Windows の既定のポリシーを変更せずに実行できます。

**アンインストール。** aiand が接続したすべてのエージェントをオフにしてから、CLI を削除します。`~/.config/aiand` 以下のプロファイルとキーは残ります。

```bash
bash ~/.aiand/cli/install.sh uninstall
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" uninstall
```

npm でインストールした場合は、`aiand init --off` を実行してから `npm uninstall -g @aiand/cli` を実行します。

**共用 PC や貸出 PC では** `--purge` を付けると、何も残しません。

```bash
bash ~/.aiand/cli/install.sh uninstall --purge
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" uninstall --purge
```

`--purge` は、最初に `aiand logout --all` を実行します。これにより、この CLI が作成したキーが無効化され、貼り付けたキーがこのマシンから削除されます(貼り付けたキーはコンソール上では有効なままです)。すべてのエージェントの設定からも ai& が削除されます。そのあと、設定ディレクトリ(`~/.config/aiand`、または `AIAND_CONFIG_DIR`)を CLI とともに削除します。サインアウトに失敗した場合は、何も削除されません。すべてのキーを無効化したあとに何かが残る場合(エージェントの設定に残ったキー、エージェントがまだ必要とするスナップショットなど)は、インストーラーがそれを表示し、設定ディレクトリを残したまま終了コード 1 で終了します。`--force --purge` はサインアウトを省略してファイルを削除しますが、その場合キーは無効化されないため、コンソールで無効化してください。

<details>
<summary>インストーラーがインストール内容を検証する方法</summary>

インストーラーは、常に最新のリリースをインストールし、main ブランチはインストールしません。npm から `@aiand/cli` の tarball をダウンロードし、npm の sha512 と GitHub のリリースに添付された `SHA256SUMS` の両方に一致した場合にだけインストールします。`AIAND_VERSION=x.y.z` でリリースを指定できます。現在のバージョンより古いものをインストールできるのは、この方法だけです。指定しない場合、インストーラーは古いバージョンへの変更を拒否します。`SHA256SUMS` 付きで公開された最初のリリースである 0.8.0 より古いものはインストールできません。到達できるリリースがない場合(または GitHub がダウンロードを制限した場合)は、何も変更せずに停止します。

この検証の対象は tarball であり、スクリプトではありません。ワンライナーは、最新の GitHub リリースからインストーラースクリプトを取得し、何かが検証される前に実行します。そのため、この最初のステップでは GitHub を信頼することになります。スクリプトは main ブランチではなくリリースのアセットから取得されるので、main への push で動作が変わることはありません。この最初のステップで GitHub を信頼したくない場合は、npm だけを信頼する `npm install -g @aiand/cli` を使ってください。ワンライナーが 404 を返す場合は、インストーラーを含むリリースがまだありません。その間は npm のコマンドを使ってください。

`update` は、以前の検証済みリリースに含まれていたインストーラーのコピーを実行します。そのため、ワンライナーとは違い、GitHub からスクリプトを再取得しません。古いインストーラー(main ブランチをクローンしていたもの)でインストールした場合は、このコピーがないため、ワンライナーをもう一度実行して更新します。

インストーラーは、新しいコピーで `--version` と `--help` を実行して確認できた後にだけ、`~/.aiand/cli` を置き換えます。途中で止められた場合(Ctrl-C やターミナルを閉じた場合)は、以前のコピーを元に戻します。強制終了された場合は、次の実行が何よりも先に元に戻します。その実行では、以前の実行が `~/.aiand` に残した `.cli-staging-*` と `cli.prev-*` のフォルダーも削除します。ただし、まだ実行中の別のインストーラーのフォルダーは、削除も元に戻しもしません。git のチェックアウトは、インストーラーが作成したものでない場合、ローカルの変更がある場合、アップストリームにないコミットがある場合、比較できるアップストリームがないブランチの場合には、手を付けずに、その旨を表示します。リリースとして考えられる大きさを超えるダウンロード(tarball は 16 MiB、チェックサムと npm のマニフェストは 4 MiB)は、そのサイズで中断し、メッセージを表示します。

</details>

## コマンド

| コマンド | 内容 |
| --- | --- |
| `aiand login` / `logout` | このマシンのセッションを開始 / 終了 |
| `aiand logout --all` | このマシンから ai& のすべてのキーと設定を削除 |
| `aiand whoami` | ID、組織、キーの有効期限 |
| `aiand status` | サインイン状態、キーの保存先、各エージェントの接続状態 |
| `aiand code` | OpenCode を ai& で開く(必要なら先に設定) |
| `aiand <agent>` | コーディングエージェントを同様に ai& で開く |
| `aiand <agent> on\|off\|status` | コーディングエージェントを ai& につなぐ / 解除する |
| `aiand init` | インストール済みのエージェントを検出して、まとめて接続を設定 |
| `aiand run-agent <agent>` | 1 回のセッションだけ、エージェントを ai& で実行 |
| `aiand restore <agent> --force` | エージェントの設定を aiand の導入前の状態に戻す |
| `aiand run <prompt>` | プロンプトを 1 回送り、結果を標準出力にストリーミング |
| `aiand chat` | 対話モード |
| `aiand models` | モデルの一覧(請求通貨での料金つき) |
| `aiand logs` | 最近のリクエスト(`--follow` あり) |
| `aiand usage` | リクエスト数とトークン数(前の期間との比較つき) |
| `aiand orgs` | 所属している組織 |
| `aiand config` | プロファイルと既定値 |
| `aiand key export` | 現在のキーを出力(ほかのツールへのパイプ用) |

ほとんどのコマンドで `--json` が使え、すべてのコマンドで `--help` が使えます。

### プロンプトの実行

```bash
aiand run "why is the sky blue?"
cat main.ts | aiand run "review this file"
git diff | aiand run "Review this diff. Be ruthless."
aiand run -m deepseek-ai/deepseek-v4.1-flash-1017 --system "be terse" "summarize CAP theorem"
aiand run --no-stream --json "hello" | jq .usage
```

パイプで渡した入力は、プロンプトに追加されます。回答は標準出力に、それ以外は標準エラー出力に出るため、`aiand run … > out.md` では回答だけが保存されます。

ターミナルでは、`aiand run` と `aiand chat` はモデルが出力したエスケープシーケンスと制御シーケンスを取り除きます。これにより、返信がクリップボードを書き換えたり、ウィンドウのタイトルを変更したり、偽装したリンクを仕込んだり、カーソルを動かして前の行を上書きしたりすることはできません。単独の復帰文字(CR)は改行として表示されます。パイプやリダイレクトした出力はフィルターされません。`aiand run … > out.md` には、モデルのテキストがバイト単位でそのまま保存されます。

回答のたびに、モデル、トークン数、コスト、時間、リクエスト ID を示す薄い色のフッターが表示されます(`-q` で非表示)。コストと時間は、通常 `--no-stream` を指定したときだけ表示されます。

```
deepseek-ai/deepseek-v4.1-flash-1017  ·  9 in / 21 out  ·  0.00001530 USD  ·  181ms  ·  919a9aa4…
```

`-m` を指定しない場合、aiand はプロファイルのモデルか、カタログの推奨既定値を使います。`-m auto` は、ご利用のアカウントが対応している場合に、ai& がリクエストごとにモデルを選びます。既定のモデルは `aiand config set model <id>` で設定できます。

推論モデルが思考だけでトークンを使い切った場合、aiand は空行を出力する代わりに、その旨を伝えて `--max-tokens` を増やすよう案内します。

### ログと使用量

```bash
aiand logs --range 1h --errors     # 失敗したリクエストだけ
aiand logs --follow                # 新しいリクエストを追跡
aiand usage --range 30days
aiand usage --metrics              # 詳細な内訳
```

どちらも、このマシンだけでなく組織全体が対象です。

## 設定

```bash
aiand config                                     # 現在の設定
aiand config set model deepseek-ai/deepseek-v4.1-flash-1017
aiand config profiles                            # プロファイルの一覧
aiand config use work                            # プロファイルを切り替える
aiand config path                                # ファイルの場所
```

設定は `~/.config/aiand/config.json`(または `$XDG_CONFIG_HOME` 以下)に保存されます。認証情報は別のファイルに保存されるので、設定ファイルは共有しても安全です。

プロファイルごとにサインインが分かれているため、`--profile work` と `--profile personal` で、異なる組織を同時に使えます。

優先順位は、フラグ、環境変数、保存されたプロファイルの順です。

保存されたサインインは、それを発行したエンドポイントに対してのみ使えます。`--base-url`、`AIAND_BASE_URL`、`AIAND_AUTH_URL`、`aiand config set` が別の場所を指している場合、CLI は保存されたキー(およびリフレッシュトークン)をそのホストに渡さず、終了コード 2 で拒否します。別のエンドポイントには、専用のプロファイルでサインインしてください: `aiand login --profile staging --base-url <url>`。`AIAND_API_KEY` は保存されないため、指定した場所にそのまま送られます。

| 変数 | 効果 |
| --- | --- |
| `AIAND_API_KEY` | このキーを使う。ログイン不要で、何も保存しない |
| `AIAND_PROFILE` | 使用するプロファイル |
| `AIAND_BASE_URL` | API のエンドポイント(既定は `https://api.aiand.com`) |
| `AIAND_AUTH_URL` | API と異なる場合のサインイン用エンドポイント |
| `AIAND_CONFIG_DIR` | 設定と認証情報の保存先 |
| `AIAND_HOME` | エージェントの設定を探すホームディレクトリ(たとえば WSL から見た Windows のホーム) |
| `AIAND_KEY_STORAGE` | `keychain`(macOS と Linux のみ)、`dpapi`(Windows のみ)、`file`、`plaintext` |
| `AIAND_SECRET_STORE_MASTER_KEY` | ファイル形式の暗号鍵を、暗号文の隣の `secret-store.key` ではなく、設定フォルダーの外から渡す。16 進数でちょうど 64 文字(32 バイトの AES-256 キー。たとえば `openssl rand -hex 32`)。それ以外はエラーになる。毎回の実行で設定したままにすること。未設定の場合や値が異なる場合は、保存されたキーを復号できない |
| `AIAND_NO_BROWSER=1` | ブラウザを開かず、サインイン用のリンクを表示する |
| `AIAND_ALLOW_GIT_TRACKED=1` | git リポジトリ内にあるエージェントの設定ファイル(dotfiles への Stow や chezmoi のリンク)にも、`on` がキーを書き込めるようにする。指定しない場合は、gitignore に追加済みのファイルでも拒否される。そのファイルを gitignore に追加し、かつこの変数を設定すること |
| `AIAND_WIPE_OUTSIDE_HOME=1` | ホームディレクトリの外にある `AIAND_CONFIG_DIR` を `logout --all` が削除できるようにする |
| `AIAND_UPDATE_CHECK=0` または `NO_UPDATE_CHECK=1` | 更新のお知らせを無効にする(`CI` が設定されている場合も無効) |
| `AIAND_DEBUG=1` | 通常は表示されない詳細(たとえば、ファイルをご自身のアカウントだけに制限できなかった理由)を表示する |
| `NO_COLOR` | 色を無効にする |

インストーラーには専用の変数(`AIAND_VERSION`、`AIAND_DIR`、`AIAND_NO_MODIFY_PATH`)があります。`install.sh` と `install.ps1` の冒頭を参照してください。

## 企業プロキシの内側で使う

`HTTPS_PROXY` または `HTTP_PROXY` のいずれかが設定されている場合、CLI はそのプロキシ経由でリクエストを送信します。`NO_PROXY` の設定も尊重します。

CLI は、オペレーティングシステムの証明書ストアにインストールされている証明書を信頼します。そのため、企業の証明書で HTTPS を検査するプロキシも、その証明書が証明書ストアにインストールされていれば利用できます。

企業の証明書がシステムの証明書ストアにない場合は、その証明書を含む PEM ファイルを `NODE_EXTRA_CA_CERTS` に設定してください。

CLI が起動するコーディングエージェントも、同じ変数をそれぞれ読み取ります。

Node 22.21 以降が必要です。

## トラブルシューティング

**`Not logged in.`(終了コード 2)。** このプロファイルにサインインがないか、セッションを更新できませんでした。`aiand login` を実行してください(既存のセッションを置き換えるには `--force` を付けます)。スクリプトでは、代わりに `AIAND_API_KEY` を設定してください。

**`The key stored for profile "…" was issued for …; refusing to send it to …`(終了コード 2)。** 保存されたサインインは、それを発行したエンドポイントに対してのみ使えます。`--base-url`、`AIAND_BASE_URL`、`AIAND_AUTH_URL`、`aiand config set` が別の場所を指しています。上書きをやめるか、そのエンドポイント用に専用のプロファイルでサインインしてください: `aiand login --profile staging --base-url <url>`。

**インストール後に `aiand` が見つからない。** インストーラーはそのフォルダーを PATH に追加しますが、すでに開いているターミナルには反映されません。新しいターミナルを開いてください。VS Code では、統合ターミナルが新しい PATH を読み込むように、VS Code を再起動してください。インストーラーが PATH を更新できなかったと表示した場合は、`~/.local/bin`(Windows では `%USERPROFILE%\.local\bin`)を自分で PATH に追加してください。

**`install.ps1` をファイルとして実行したときに、PowerShell がスクリプトの実行が無効だと表示する。** ワンライナーの `irm … | iex` は影響を受けません。`update` や `uninstall` のようにファイルを実行する場合は、[更新とアンインストール](#更新とアンインストール)に示した形式を使ってください: `pwsh -ExecutionPolicy Bypass -File … install.ps1 …`。これはそのプロセスだけに適用されます。

**Windows で、`aiand status` が PowerShell は制約付き言語モードで動作していると表示する。** 組織のポリシーにより Windows DPAPI の呼び出しがブロックされているため、aiand は代わりに `%USERPROFILE%\.config\aiand\` 以下の所有者のみが読めるファイルにキーを保存します。サインインやそのほかの機能は問題なく使えます。このファイルを保存時に暗号化するには、`AIAND_SECRET_STORE_MASTER_KEY` を設定してください([API キーの保存場所](#api-キーの保存場所)を参照)。エンドポイントセキュリティが PowerShell をブロックしている場合は、`AIAND_KEY_STORAGE=file` を設定して、aiand が DPAPI を試さないようにしてください。

問題を報告するときは、`aiand --version` と `aiand status` の出力を含めてください。

## 終了コード

| コード | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | リクエストまたは使い方のエラー(メッセージに内容が表示されます) |
| `2` | サインインしていない、またはセッションを更新できなかった |
| `3` | サインインが拒否された、またはコードの有効期限が切れた |
| `70` | aiand のバグ。スタックトレースが表示されるので、報告してください |
| `127` | 不明なコマンド、またはエージェントがインストールされていない |
| `130` | 中断された(Ctrl-C) |
| `143` | 終了させられた(SIGTERM) |

`aiand status` は、サインインしていれば、キーの確認のために ai& へ接続できなくても終了コード `0` を返します(`--json` では `reachable: false`)。終了コード `1` を返すのは、サインアウトしている場合だけです。これにより、これを判定に使っているスクリプトは、障害中も動き続けます。

## コントリビューションとセキュリティ

ソースからのビルド、テスト、リリース: [CONTRIBUTING.md](CONTRIBUTING.md)(英語)
脆弱性は非公開で報告してください: [SECURITY.md](SECURITY.md)(英語)
aiand-cli の開発に協力してくれた方々: [THANKS.md](THANKS.md)

## ライセンス

Apache-2.0
