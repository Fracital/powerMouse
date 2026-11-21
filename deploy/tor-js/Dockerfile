# Builds tor-js (arti compiled to wasm, ethereum/tor-js) from its pinned
# release commit with the tools its build pins, plus the patches in patches/
# unless PATCHES=0. Driven by build.sh; the outputs land in /out (copied to
# deploy/tor-js/out on the host).
ARG RUST_VERSION
FROM docker.io/library/rust:${RUST_VERSION}-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates xz-utils git \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown
ARG WASM_PACK_VERSION
RUN curl -fsSL "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar xz -C /tmp \
 && install -m755 /tmp/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack /usr/local/bin/ \
 && wasm-pack --version
ARG BINARYEN_VERSION
RUN curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" | tar xz -C /tmp \
 && install -m755 /tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt /usr/local/bin/ \
 && cp -r /tmp/binaryen-version_${BINARYEN_VERSION}/lib/* /usr/local/lib/ 2>/dev/null; ldconfig; wasm-opt --version
ARG NODE_VERSION
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar xJ -C /usr/local --strip-components=1 \
 && node --version

ARG TOR_JS_REV
RUN git clone https://github.com/ethereum/tor-js.git /src \
 && cd /src && git checkout --detach "$TOR_JS_REV" \
 && test "$(git rev-parse HEAD)" = "$TOR_JS_REV"
WORKDIR /src
RUN npm ci --ignore-scripts
# the crates first, so a patch change does not fetch them again
RUN cargo fetch --locked --target wasm32-unknown-unknown
COPY patches /patches
ARG PATCHES=1
# the patches committed with a fixed author and date: build.rs embeds the
# commit, and a timestamp when the tree is dirty, so only a clean tree builds
# the same wasm twice
RUN if [ "$PATCHES" = 1 ]; then for p in /patches/*.patch; do [ -e "$p" ] || continue; git apply --check "$p" && git apply "$p"; done \
 && git add -A && GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z \
    git -c user.name=deploy-tor-js -c user.email=deploy-tor-js@localhost commit -q --allow-empty -m "deploy/tor-js patches"; fi \
 && test -z "$(git status --porcelain)"
RUN bash scripts/build.sh --release \
 && mkdir -p /out \
 && cp -r dist /out/dist \
 && sha256sum dist/tor_js_bg.wasm | tee /out/SHA256 \
 && git -C /src diff --stat "$TOR_JS_REV" HEAD > /out/PATCHED \
 && git -C /src rev-parse HEAD > /out/COMMIT
# what publish.sh puts beside dist/ in the package: tor-js's manifest and
# licences (a layer of its own, so it reuses the build above)
RUN cp /src/package.json /src/LICENSE-MIT /src/LICENSE-APACHE /out/
