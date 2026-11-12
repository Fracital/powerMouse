# The xor codec

`codec: 'xor'` (the default) seals every routed URL so that no character of
the URL it stands for shows in the route, the way Ultraviolet's routes
look. What it is for: a URL filter, a proxy log or a history list that
reads the proxy's addresses learns neither the site nor its path. What it
is not: encryption. The key sits in the service worker's database and in
every proxied realm, and a URL the reader already knows gives back the
stream for every shorter one under the same key.

## The wire

A route's last segment (`/stomp/<id>/<kind>/<sealed>`) is the URL's
origin, path and query (`StompURL.encode`) as bytes, each XORed with a
byte of a stream drawn from the controller's key, written in the URL-safe
base64 alphabet (`A-Z a-z 0-9 - _`) without padding.

- **Bytes.** A text whose characters are all ASCII (what a parsed URL
  serializes to) is its characters. Any other text is the byte `0xFF` and
  then every UTF-16 code unit, high byte first, so any string comes back as
  it was, a lone surrogate included. A text has one form: an all-ASCII text
  written the wide way is no seal.
- **Stream.** Byte `n` is XORed with byte `n & 3` (from the low end) of
  `word(n >> 2)`, where `word(j) = mix(mix(a + j * 0x9E3779B9) ^ b)` in
  wrapping 32-bit arithmetic, `a` and `b` are the key's two halves and
  `mix` is the 32-bit finalizer of MurmurHash3. It is addressed by
  position, so a long text is sealed in pieces.
- **Key.** 16 lower-case hex digits (`a` then `b`), drawn from
  `crypto.getRandomValues` once per scope and kept in the service worker's
  database. A stored key of the codec before this one (three hex digits at
  the most) is replaced by a new one.
- **Opening.** A character outside the alphabet, a length no seal has
  (`4n + 1`), bits set after the last byte, or bytes that are no text's
  make the segment no seal: it opens to nothing and the route answers as
  any route that names no URL.

The same text under the same key is the same seal, so two routes of one
site begin alike; nothing of either reads as the site.

## What else is sealed

- The route kinds that name a site: a nested document's top
  (`html:nested:<sealed>`) and a partitioned worker's
  (`js:worker:top:<sealed>`).
- A link's route for `:visited` (`<scope>~/<sealed>`, src/visited.ts
  linkRoute and decodeLinkRoute): the link's context and URL, through the
  same codec.
- The storage bridge's asynchronous writes name their origin and key in
  their URL (`<address>localStorage/ordered?...&origin=<sealed>&key=<sealed>`).
- A GET form without an action submits to the document's own address, and
  the browser writes its fields after the route; the worker answers that
  request with a redirect to the sealed address. A form with an action goes
  through `html:form`, which does the same. The fields are in clear for that
  one request, as the browser wrote them.
- The demo keeps its active tab in its own fragment as the tab's route
  (`#html/<sealed>`, from `controller.route()`), read back with
  `controller.unroute()`; a fragment holding the URL itself, as the demo
  wrote it before, still opens. Its address-bar suggestions post what was
  typed in the body.

Not sealed: a URL's fragment. It stays after the route as the page wrote
it, because the browser itself reads it there (scrolling to an anchor,
`:target`, `hashchange`, a same-document navigation).

## Where it runs

`rust/codec` builds `assets/codec.wasm` (1,449 bytes: no import, one page
of memory, two 16 KiB buffers at fixed places, exports `i o e d`). The
build carries it in every bundle that seals a URL as text
(`process.env.STOMP_CODEC_WASM`, `build.js`), because a document's client
reads its own address before any page script and before anything
asynchronous could have finished; `src/wasm/codec.ts` compiles it
synchronously the first time a realm seals or opens a URL. A proxied top
holds the instance and the frames under it seal in their top's (one
instance per page). `src/xorWire.ts` writes the same bytes in JavaScript
wherever a realm holds no instance: the rewriter library and the light
library (a file of their own, built without the module, which the bundle
that loads it carries already; the JavaScript is as fast), a document under a blocking list's `$csp=` policy
(`Config.codecModule`, which may refuse the compile and would report it to
the page), a bundle built without the module, an instance that trapped.

## Checks

- `node rust/host/codec.mjs` compares the module and the JavaScript over
  the URLs in the test data, generated URLs (IDN, IP literals, non-ASCII
  paths and queries, fragments, `data:` and `blob:` URLs, nested marks and
  sites), texts across the module's buffers up to 200 KB, every length up
  to 600 of random text, and what is no seal; `--bench` times both.
- The `codec` suite runs that over a smaller corpus, checks the documented
  vectors and that each bundle carries the module once, and in a browser
  that a top seals in its own instance and its frames in its top's, that no
  routed address the browser loads names the site or its path, and that a
  GET form without an action lands at its sealed address.
- `deploy/rust/test.sh -p codec` runs the crate's own tests (the same
  vectors, round trips of every length, pieces, refusals).
