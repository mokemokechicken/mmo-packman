FROM rust:1.85-bookworm AS build
WORKDIR /app
COPY . .
RUN cargo build --release --manifest-path rust/server/Cargo.toml --bin server

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/rust/server/target/release/server /usr/local/bin/server
ENV PORT=8080
EXPOSE 8080
CMD ["server"]
