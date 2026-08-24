# Stage 1: compile the Go reference capability adapter from source. The toolchain is
# needed only to build it, never to run it, so it stays out of the runner image.
FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS go-adapter
RUN apk add --no-cache go=1.26.3-r0
COPY fixtures/capability/adapters/go /build
RUN cd /build && CGO_ENABLED=0 GOFLAGS=-trimpath go build -ldflags "-s -w" -o /capability-adapter-go adapter.go

FROM node:24.19.0-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

RUN apk add --no-cache \
    docker-cli=29.5.3-r0 \
    docker-cli-compose=5.1.4-r0 \
    git=2.54.0-r0 \
    python3=3.14.7-r1

# The compiled Go adapter only; CAP-001 still proves three independent language
# implementations agree, without carrying a 190 MB toolchain at runtime.
COPY --from=go-adapter /capability-adapter-go /usr/local/bin/capability-adapter-go

ENV NODE_ENV=production
WORKDIR /runner
COPY --chown=node:node package.json package-lock.json LICENSE NOTICE ./
COPY --chown=node:node src ./src
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node requirements ./requirements
COPY --chown=node:node verification ./verification
COPY --chown=node:node tooling ./tooling
USER node
ENTRYPOINT ["node", "src/cli.ts"]
