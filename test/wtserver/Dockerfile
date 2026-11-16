# The fixture's build image: deploy/rust's pinned toolchain (rust nightly by
# digest, wasm32 target, wasm-bindgen and binaryen by checksum) plus clang 14
# from Debian bookworm at an exact version, because quinn-proto depends on
# ring on wasm32-unknown-unknown and ring compiles C (the same clang the
# deploy/epoxy image builds ring with).
ARG BASE
FROM ${BASE}
ARG CLANG
RUN apt-get update \
 && apt-get install -y --no-install-recommends "clang-14=${CLANG}" \
 && rm -rf /var/lib/apt/lists/* \
 && clang-14 --version
ENV CC_wasm32_unknown_unknown=clang-14
