FROM node:22-bookworm
RUN apt-get update -qq && apt-get install -y -qq tmux strace openssl procps >/dev/null && rm -rf /var/lib/apt/lists/*
ARG VERSIONS="2.1.311 2.1.318 2.1.319"
# Install scripts on purpose: Claude Code's postinstall links its native binary.
RUN for v in $VERSIONS; do npm install --silent --prefix /opt/claude/$v @anthropic-ai/claude-code@$v; done
