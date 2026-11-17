# syntax=docker/dockerfile:1
FROM node:22-slim

# The Claude Code CLI is only needed for REVERSE_AI_PROVIDER=claude-cli (the default).
# Build with --build-arg INSTALL_CLAUDE_CLI=false for a smaller, API-only image.
ARG INSTALL_CLAUDE_CLI=true
ARG CLAUDE_CLI_VERSION=2.1.326
RUN if [ "$INSTALL_CLAUDE_CLI" = "true" ]; then \
      npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" && npm cache clean --force; \
    fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# Inside a container the server must listen on all interfaces; publish the port
# to 127.0.0.1 on the host unless you have put something in front of it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4517

USER node
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/config').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.js"]
