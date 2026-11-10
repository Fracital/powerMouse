# Builds epoxy-transport from pinned upstream sources plus the patches in
# patches/, inside a Rust nightly container. Driven by build.sh; the outputs
# land in /out (copied to deploy/epoxy/out on the host).
FROM rustlang/rust:nightly-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends jq curl ca-certificates xz-utils clang lld git \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown && rustup component add rust-src

# epoxy-tls's build.sh insists on this exact wasm-bindgen
ARG WBG=0.2.100
RUN curl -fsSL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WBG}/wasm-bindgen-${WBG}-x86_64-unknown-linux-musl.tar.gz" | tar xz -C /tmp \
 && install -m755 /tmp/wasm-bindgen-${WBG}-x86_64-unknown-linux-musl/wasm-bindgen /usr/local/bin/ \
 && wasm-bindgen -V
ARG BINARYEN=version_124
RUN curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz" | tar xz -C /tmp \
 && install -m755 /tmp/binaryen-${BINARYEN}/bin/wasm-opt /usr/local/bin/ \
 && cp -r /tmp/binaryen-${BINARYEN}/lib/* /usr/local/lib/ 2>/dev/null; ldconfig; wasm-opt --version
ARG NODE=22.21.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz" | tar xJ -C /usr/local --strip-components=1 \
 && node --version && npm --version

# --- sources, pinned ---------------------------------------------------------
ARG HYPER_UTIL_WASM_REV
ARG EPOXY_TLS_REV
ARG EPOXY_TRANSPORT_REV
ARG HYPER_REV
WORKDIR /src
RUN git clone -q https://github.com/r58Playz/hyper-util-wasm.git hyper-util-wasm \
 && git -C hyper-util-wasm checkout -q "$HYPER_UTIL_WASM_REV"
RUN git clone -q https://github.com/MercuryWorkshop/epoxy-tls.git epoxy-tls \
 && git -C epoxy-tls checkout -q "$EPOXY_TLS_REV"
RUN git clone -q https://github.com/MercuryWorkshop/EpoxyTransport.git epoxy-transport \
 && git -C epoxy-transport checkout -q "$EPOXY_TRANSPORT_REV"
RUN git clone -q https://github.com/hyperium/hyper.git hyper \
 && git -C hyper checkout -q "$HYPER_REV"

# --- patches, in numeric order, each checked before it is applied ------------
COPY patches /patches
RUN for repo in hyper hyper-util-wasm epoxy-tls epoxy-transport; do \
      for p in /patches/$repo/*.patch; do \
        [ -e "$p" ] || continue; \
        echo "[patch] $repo <- $(basename "$p")"; \
        git -C "$repo" apply --check "$p" || { echo "patch does not apply: $p" >&2; exit 1; }; \
        git -C "$repo" apply "$p"; \
      done; \
    done

# --- epoxy-tls: full + minimal packages into epoxy-tls/client -----------------
WORKDIR /src/epoxy-tls/client
RUN RELEASE=1 bash publish.sh && ls full minimal

# --- epoxy-transport: bundle against the sibling build ------------------------
WORKDIR /src/epoxy-transport
RUN rm -f pnpm-lock.yaml pnpm-workspace.yaml \
 && npm install --no-audit --no-fund --loglevel=error \
 && npm run build \
 && ls -la dist

# --- stomp-h3: HTTP/3 over wisp UDP, shipped in epoxy-transport's dist/h3/ ----
# Our own crate (deploy/epoxy/h3, quinn + h3), not an upstream patch; stomp's
# Http3Transport loads it next to the transport module when `http3` is on.
COPY h3 /src/stomp-h3
RUN bash /src/stomp-h3/build.sh /src/epoxy-transport/dist/h3 \
 && rm -f /src/epoxy-transport/dist/h3/stomp_h3_bg.wasm.d.ts

# --- outputs ------------------------------------------------------------------
RUN mkdir -p /out/epoxy-tls /out/epoxy-transport \
 && cd /src/epoxy-tls/client && cp -r full minimal package.json README.md LICENSE /out/epoxy-tls/ \
 && cd /src/epoxy-transport && cp -r dist lib package.json package-lock.json README.md .gitignore /out/epoxy-transport/ \
 && cp LICENSE /out/epoxy-transport/ 2>/dev/null || true \
 && printf 'hyper-util-wasm %s\nepoxy-tls %s\nepoxy-transport %s\nhyper %s\n' "$HYPER_UTIL_WASM_REV" "$EPOXY_TLS_REV" "$EPOXY_TRANSPORT_REV" "$HYPER_REV" > /out/UPSTREAM \
 && (cd /patches && find . -name '*.patch' | sort) >> /out/UPSTREAM \
 && (cd /src/stomp-h3 && printf 'stomp-h3 %s\n' "$(cat Cargo.toml Cargo.lock src/*.rs patches/*/*.patch | sha256sum | cut -c1-12)") >> /out/UPSTREAM
