# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo

# Install from the workspace root so the agent/web workspace link resolves
# the same way it does locally, then build only the agent package.
COPY package.json package-lock.json ./
COPY agent/package.json agent/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY agent/ agent/
RUN npm run build --workspace agent

# Production dependencies of the agent workspace only. `npm prune --omit=dev`
# after a full install kept the web workspace's runtime packages (react,
# react-dom, scheduler) and both workspace links: 28 top-level packages
# instead of 12. web/package.json is still copied because npm ci validates
# the lockfile against every workspace.
FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY agent/package.json agent/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace agent

FROM node:22-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV HOST=0.0.0.0

# npm workspaces hoists agent's dependencies into the root node_modules —
# preserve that same relative layout (agent/ alongside root node_modules)
# rather than collapsing into a flat /app, since Node's resolution walks up
# through node_modules directories to find them.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/agent/package.json ./agent/package.json
COPY --from=build /repo/agent/dist ./agent/dist
COPY --from=build /repo/agent/evals/reports ./agent/evals/reports

# The non-root runtime writes traces here locally; deploys can mount a
# persistent directory and override RAW_DATA_ROOT.
RUN mkdir -p /repo/raw_data && chown node:node /repo/raw_data
ENV RAW_DATA_ROOT=/repo/raw_data

WORKDIR /repo/agent
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
