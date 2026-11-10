# The toolchain every Rust/wasm artifact of stomp is built with (the JS
# rewriter, the blocker, WebRTC over wisp): a Rust nightly pinned by image
# digest, the wasm32 target with rust-src for -Z build-std, binaryen and the
# wasm-bindgen CLI, each download checked against the checksum in pins.env.
# No sources: build.sh copies a crate in and the artifact out (docker's
# filesystem here is not this machine's, so there are no bind mounts).
ARG RUST_IMAGE
FROM ${RUST_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# wasm32-wasip1 too: a crate that needs a clock and randomness from the
# host (WebRTC's str0m stack) takes them through a small WASI shim in its
# worker rather than wasm-bindgen glue (rust/<crate>/wasm-target names it)
RUN rustup target add wasm32-unknown-unknown wasm32-wasip1 && rustup component add rust-src

ARG BINARYEN
ARG BINARYEN_SHA256
RUN curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz" -o /tmp/binaryen.tgz \
 && echo "${BINARYEN_SHA256}  /tmp/binaryen.tgz" | sha256sum -c - \
 && tar xzf /tmp/binaryen.tgz -C /tmp \
 && install -m755 "/tmp/binaryen-${BINARYEN}/bin/wasm-opt" /usr/local/bin/ \
 && (cp -r "/tmp/binaryen-${BINARYEN}/lib/"* /usr/local/lib/ 2>/dev/null || true) && ldconfig \
 && rm -rf /tmp/binaryen* && wasm-opt --version

ARG WASM_BINDGEN
ARG WASM_BINDGEN_SHA256
RUN curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN}/wasm-bindgen-${WASM_BINDGEN}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/wbg.tgz \
 && echo "${WASM_BINDGEN_SHA256}  /tmp/wbg.tgz" | sha256sum -c - \
 && tar xzf /tmp/wbg.tgz -C /tmp \
 && install -m755 "/tmp/wasm-bindgen-${WASM_BINDGEN}-x86_64-unknown-linux-musl/wasm-bindgen" /usr/local/bin/ \
 && rm -rf /tmp/wbg* && wasm-bindgen -V

# the crate build runs here; build.sh copies the workspace in (compile.sh too)
WORKDIR /work
