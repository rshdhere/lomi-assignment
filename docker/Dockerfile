FROM node:24-bookworm-slim AS app
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV HUSKY=0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.28.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM app AS web
ARG NEXT_PUBLIC_API_ORIGIN=http://localhost:4000
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build
CMD ["pnpm","--filter","web","start"]
