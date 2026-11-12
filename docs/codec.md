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
- A document's fragment, and a link route's: `#~<sealed>` (empty stays
  `#`, as an empty query stays `?`: src/urlShape.ts). A subresource's
  fragment stays as written: the browser reads it there (an SVG sprite's
  `#icon`, a filter's `url(#blur)`) and never sends it. See "Fragments"
  below for how the page still gets every native fragment behaviour.
- A GET form's fields. The browser writes a GET submission's entries after
  the action's route; once the page's own formdata listeners have seen
  them, the inject (`FormQuery`) replaces them with one unnamed entry
  holding the query sealed, so the request reads `?=<sealed>` and names no
  field. The worker opens it (`html:form` and the document route redirect
  to the sealed address with the query inside the seal). A FormData the
  page makes itself (`new FormData(form)`, which fires formdata too) is
  left as it is.
- The demo keeps its active tab in its own fragment as the tab's route
  (`#html/<sealed>`, from `controller.route()`), read back with
  `controller.unroute()`; a fragment holding the URL itself, as the demo
  wrote it before, still opens. Its address-bar suggestions post what was
  typed in the body.

## Fragments

The browser reads a document's fragment itself: it scrolls to the element
it names (and keeps it in view while the page loads), matches `:target`,
opens a closed `<details>` around it, decides whether a navigation stays in
the document and whether `hashchange` fires. The inject's Fragment module
keeps all of that native while the frame's address and its history entries
hold only the seal:

- A fragment navigation the page makes in its own document
  (location.hash, href, assign and replace, `navigation.navigate()`, a
  link to it the page or the user clicks, the steps the Visited module
  makes of one) goes to the fragment as written, the current entry turned to its fragment as
  written a moment before, so every comparison the browser makes is the
  native one. For a link, its href is that URL for the time of the click
  only (not for a modifier click or a new window, where the route shows).
  Once the navigation succeeded the entry is sealed again (a
  `replaceState`), before the page's hashchange listeners.
- Where the browser arrives at a sealed fragment on its own (a document
  loaded at one: an iframe's src, a redirect, a reload; a traversal to an
  entry), the module has the browser apply the fragment as written: the
  entry turned to it, a replacing navigation to it, the entry sealed
  again, all in one call (a traversal and a reload keep the position they
  restore).
- Those history calls are the proxy's, not the page's: every event they
  fire (navigate, currententrychange, popstate, navigatesuccess,
  navigateerror, an entry's dispose) is stopped before the page's
  listeners, the Navigation API state is kept, and the page keeps the entry
  object it had (same object, same id: `navigation.currentEntry`,
  `entries()`, `from`).
- A fragment directive (`#frag:~:text=word`) is taken out of the document's
  URL as the browser does. What it highlights is not applied through the
  proxy: the browser applies it to the document it navigates to, which is
  the shell, before the page is written into it.

What differs: `history.state` after the proxy's own `replaceState` is an
equal copy, not the same object; an entry the page holds that the proxy
re-wrote gets no `dispose` when the page later prunes it.

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
  routed address the browser loads names the site, its path, a fragment or
  a form field, and that a GET form without an action lands at its sealed
  address.
- The `fragments` suite compares a page natively and through the proxy at
  every fragment behaviour above (load, location.hash read and written,
  links clicked once and twice, back and forward, replace, pushState,
  `navigation.navigate()`, `<a name>`, empty and non-ASCII fragments, a
  closed `<details>`, a reload, cross-document navigations and their
  referrer, text directives, GET forms with and without an action), every
  event the page hears with its URLs and state, and that no address or
  request shows a fragment or a field.
- `deploy/rust/test.sh -p codec` runs the crate's own tests (the same
  vectors, round trips of every length, pieces, refusals).
