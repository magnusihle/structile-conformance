FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ENV NODE_ENV=production
WORKDIR /runner
COPY --chown=node:node package.json package-lock.json LICENSE NOTICE ./
COPY --chown=node:node src ./src
COPY --chown=node:node requirements ./requirements
COPY --chown=node:node verification ./verification
COPY --chown=node:node tooling ./tooling
USER node
ENTRYPOINT ["node", "src/cli.ts"]
