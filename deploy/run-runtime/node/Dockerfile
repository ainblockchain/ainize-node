# Runner image for `POST /api/run` with language "node" (src/run-sandbox.ts builds and tags it).
# Node 20 and its standard library; no packages. The script runs as uid 1000 (the image's `node` user)
# with a read-only rootfs, so anything it needs beyond this has to travel in the request's `files`.
FROM node:20-slim
ENV NODE_ENV=production HOME=/work
USER node
WORKDIR /work
