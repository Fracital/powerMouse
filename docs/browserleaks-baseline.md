# browserleaks.com: native Chrome vs Chrome through stomp

Every test page of browserleaks.com, loaded in native Chrome and through
stomp, field by field. What differs is either a gap (something a site can
see that native Chrome does not show), an inherent difference (the egress
is the wisp server's, the page sits in the host's frame), or a headless
artifact. Measured 2026-11-10; the gaps fixed since are marked with the
commit that fixed them and their regression suite.

## How it was measured

- Chrome 152.0.7977.64, Linux, headless, launched with `--user-agent` set
  to the regular Chrome 152 UA (a launch flag, so workers and the service
  worker send it too, not only the page).
- Every page loaded natively twice, each in a fresh context: a field that
  differs between the two native loads is volatile (timestamps, the
  connection's JA3 with Chrome's extension shuffling, DNS resolver IPs,
  `downlink`) and is ignored.
- Through stomp: the local demo (`npm run demo`) in same-origin mode
  (`127.0.0.1`) and isolated mode (`localhost`, proxy origin `127.0.0.1`),
  and the live https://stomp.fracit.al (resolver rule mapping it and
  holywisp.fracit.al to the edge). The page was opened from the landing
  form, the newest `/stomp/<id>/html/` frame read once its `innerText`
  stopped changing, and the proxied-only page errors kept.
- Before: base commit 5d9b42b. After: the fixes below, local demo, both
  modes (the probes are a job's scratch scripts, not checked in; the
  regression suites are).
- `/content-filters` answers 404 natively too; it is no test page. The nav
  lists ip, javascript, webrtc, canvas, webgl, webgpu, fonts, geo, features,
  tls, proxy, quic, http2, tcp, chrome, client-hints, dns, css, rects,
  donottrack and resource-urls (flash, silverlight and java are stubs).

## Results

| Test                                                      | Native                                                                                                                    | Proxied (before)                                                                                                | Gap       | Cause                                                                                                                        | Now                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| IP: address, geo                                          | this machine's                                                                                                            | the wisp server's                                                                                               | no        | inherent: the egress is the wisp server                                                                                      |                                                                                          |
| IP: Priority                                              | `u=0, i`                                                                                                                  | live: missing                                                                                                   | yes       | the HTTP/3 wrapper declared no field support, so the host dropped Priority with HTTP/3 on (live)                             | fixed, 25fe658, fields-unit                                                              |
| IP: IPv6 test                                             | `ERR_ADDRESS_UNREACHABLE`                                                                                                 | epoxy `InvalidDnsName`                                                                                          | yes, low  | epoxy cannot do https to an IPv6 literal                                                                                     | left (transport)                                                                         |
| IP, TCP: hops, MTU, JA4T                                  | this machine's                                                                                                            | the wisp server's                                                                                               | no        | inherent (docs/fingerprint.md item 7)                                                                                        |                                                                                          |
| JavaScript                                                | tab-separated table                                                                                                       | the "Rest of window.navigator" table ran together                                                               | yes       | fragment parsing in body context (below)                                                                                     | fixed, 2d892b1                                                                           |
| JavaScript: outer size                                    | toolbar between outer and inner (real window)                                                                             | `outerHeight === innerHeight`, at 0,0                                                                           | yes       | Framing spoofed a toolbarless window                                                                                         | fixed, ce6610a, window-geometry                                                          |
| JavaScript: `navigator.serviceWorker`, `navigator.login`  | present                                                                                                                   | missing                                                                                                         | yes       | deleted on purpose (Navigator and Credentials modules)                                                                       | left (emulated service workers behind `serviceWorkers`, off by default)                  |
| JavaScript: AudioContext state                            | `suspended`                                                                                                               | `running` (same-origin, live)                                                                                   | maybe     | the host's user activation from the address bar; a bare page matches native                                                  | left                                                                                     |
| JavaScript, CSS: viewport                                 | 1280x900                                                                                                                  | 1280x803                                                                                                        | no        | inherent: the demo's toolbar takes height                                                                                    |                                                                                          |
| JavaScript: screen (isolated)                             | 1280x900                                                                                                                  | 800x600                                                                                                         | no        | headless artifact: Playwright's emulation does not reach an out-of-process frame                                             |                                                                                          |
| WebRTC                                                    | No Leak, IP matches                                                                                                       | live: "WebRTC IP doesn't match your Remote IP"                                                                  | yes       | WebRTC is not proxied: STUN answers with the user's real IP, the page loaded from the wisp server's                          | fixed, webrtc suite, docs/webrtc.md (Public IP "-" in both modes)                        |
| Canvas                                                    | tables with tabs                                                                                                          | cells ran together                                                                                              | yes       | fragment parsing                                                                                                             | fixed, 2d892b1 (identical to native now)                                                 |
| WebGL                                                     | identical                                                                                                                 | identical; isolated: Power Preference low-power                                                                 | no        | inherent: the isolated frame is a cross-origin child frame                                                                   |                                                                                          |
| WebGPU, Fonts, Chrome, Proxy, Do Not Track, Resource URLs | identical                                                                                                                 | identical                                                                                                       | no        |                                                                                                                              |                                                                                          |
| Geolocation                                               | prompt pending                                                                                                            | `PERMISSION_DENIED` at once; isolated adds a permissions-policy violation                                       | yes       | the host's frame has no `allow` list, so the page cannot ask                                                                 | left (host policy)                                                                       |
| Features                                                  | ServiceWorker API true; console quiet                                                                                     | false; seven "Failed to construct 'URL': Invalid URL" errors                                                    | yes       | serviceWorker deleted; the CSS rewriter logged every url() it could not resolve                                              | console fixed, 944ae8f, css-invalid-urls; serviceWorker left                             |
| TLS: JA4, JA3n, Akamai                                    | as native                                                                                                                 | match                                                                                                           | no        | docs/fingerprint.md                                                                                                          |                                                                                          |
| TLS: mixed content                                        | Active: Blocked; Passive: Upgraded to HTTPS                                                                               | "Mixed Content Loaded" for both                                                                                 | yes       | every proxied page is https or loopback in proxy URL space, so Chrome's own check never fires                                | fixed, abb4c26, mixed-content (below)                                                    |
| TLS: ECH table                                            | tab-separated; ECH Success True, outer SNI tls-outer.browserleaks.com                                                     | cells ran together; ECH Success False, outer SNI tls.browserleaks.com                                           | yes       | tabs: fragment parsing (no CSS difference: the cells are `table-cell` in both). ECH: epoxy sends only a GREASE ECH extension | tabs fixed, 2d892b1; ECH left (transport)                                                |
| QUIC                                                      | QUIC connection, h3 SETTINGS `1:65536;6:262144;7:100;51:1;GREASE...`                                                      | local: no QUIC (HTTP/3 is off by default); live: SETTINGS `GREASE;6:262144;8:0;...`, a 1200-byte second Initial | yes       | stomp-h3's SETTINGS and frames; quinn's Initial padding (docs/fingerprint.md item 5); QUIC JA4 matches                       | left                                                                                     |
| HTTP/2: frames                                            | tables with tabs                                                                                                          | ran together                                                                                                    | yes       | fragment parsing                                                                                                             | fixed, 2d892b1 (identical to native now)                                                 |
| HTTP/2: `origin` of a CORS fetch                          | after `accept`                                                                                                            | right after `:path`                                                                                             | yes       | headerOrder put Origin first for every CORS GET (Blink's place for an element's load)                                        | fixed, ca1fc28, field-order                                                              |
| Client Hints: page table                                  | tabs                                                                                                                      | ran together                                                                                                    | yes       | fragment parsing                                                                                                             | fixed, 2d892b1                                                                           |
| Client Hints: high-entropy headers                        | Full-Version, Platform-Version, Arch, Bitness, WoW64, Model, Viewport-Width, DPR, Device-Memory, RTT, ECT, Prefers-* sent | "not received"                                                                                                  | yes       | the worker implements no Accept-CH / Critical-CH: only the low-entropy hints the browser adds go out                         | left                                                                                     |
| DNS                                                       | resolver table                                                                                                            | ran together; the edge's resolvers                                                                              | table yes | fragment parsing; the resolvers are inherent                                                                                 | table fixed, 2d892b1                                                                     |
| CSS                                                       | as native but the viewport                                                                                                | viewport only                                                                                                   | no        | inherent                                                                                                                     |                                                                                          |
| Rects                                                     | `#inside` positioned and transformed                                                                                      | unstyled (x 8, width 905): other hashes                                                                         | yes       | the sandboxed frame (no allow-scripts) lost every inline style: the shell's placeholder script carried no nonce              | fixed, a352e15, sandbox-styles; the table's tabs, 2d892b1                                |
| Any page: WebSocket                                       | close codes as sent                                                                                                       | a failed connection never closed; `close()` read 1000; `close(code, reason)` never ended                        | yes       | the transport reports an error without a close, and epoxy answers no close but 1000 without a reason                         | fixed, 7f018a9, websocket-close; the server's own close code stays epoxy's (always 1000) |

After the fixes (local demo, same-origin mode, the same probe): Canvas,
HTTP/2 and Rects read exactly as natively; the TLS page says Active
Content Blocked and Passive Content Upgraded to HTTPS, as natively, with
Chrome's console messages; JavaScript differs only in the viewport, the
AudioContext state and `serviceWorker`/`login`; Features only in
ServiceWorker API (and so its hash); Client Hints only in the high-entropy
hints; DNS only in the resolvers.

### Fragment parsing (the run-together tables)

browserleaks fills its tables with `tbody.innerHTML = '<tr>...'`. The
innerHTML, outerHTML, insertAdjacentHTML and setHTMLUnsafe hooks parsed
every string as the content of a body, where `<tr>` and `<td>` are dropped:
only the text landed in the tbody, so `innerText` lost the tab between
cells. The ECH table's missing tabs were the same thing, not a CSS
difference (the computed `display` of its rows and cells is the same
natively and through the proxy). Markup now parses in the element's own
context (fragment-context suite: rows, cells, SVG, textarea, title,
colgroup, select, template, and the insertAdjacent methods' positions,
return values and errors). Before the fix the suite's page threw at its
first table in both modes.

### Mixed content

Measured natively case by case (mixed-content suite, from an https page and
from an http one), then enforced in the service worker by the request's
destination and its client's real URL, and in the inject for what never
reaches the worker (src/mixedContent.ts):

| Load from an https page                                                           | Chrome 152                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `<img src=http:>`, `<input type=image>`, CSS image, `<link rel=preload as=image>` | upgraded to https on the same port; a failed upgrade errors, no fallback; `currentSrc` reads https                        |
| `<audio>`, `<video>`                                                              | upgraded, plus a second warning from the media player                                                                     |
| `<img srcset>`, `<picture><source srcset>`                                        | blocked (the image set context is not upgraded)                                                                           |
| an IP address or localhost host, passive                                          | not upgraded, loads over http with a warning (a loopback one too)                                                         |
| scripts, module scripts, stylesheets, `@import`, preload of a script, prefetch    | blocked                                                                                                                   |
| iframe                                                                            | navigation cancelled, the frame stays on its document, no `load`                                                          |
| object, embed                                                                     | blocked (object fires `error`, embed nothing)                                                                             |
| fetch (any mode), XHR, EventSource, sendBeacon                                    | network error; EventSource closed for good; sendBeacon answers false                                                      |
| a worker's fetch, importScripts                                                   | blocked (TypeError, NetworkError)                                                                                         |
| `new WebSocket('ws:')`                                                            | SecurityError from the constructor                                                                                        |
| a form to http                                                                    | warned twice; cancelled in a nested frame; "Form is not secure" interstitial at the top                                   |
| http to 127.0.0.1 or localhost, active                                            | allowed (potentially trustworthy)                                                                                         |
| `upgrade-insecure-requests` (header or meta, inherited by frames)                 | every insecure request upgraded first, navigations and ws: included, whatever the page's scheme; loopback is not upgraded |
| `block-all-mixed-content`                                                         | no change from the default                                                                                                |

The console gets Chrome's own messages: a block names the https top
(Chrome names the outermost frame the content is mixed in), an upgrade the
document itself. Before the fix, 31 of the fixture's 40 loads (same-origin
mode) and 32 (isolated) differed from native on the https page, and every
console message was missing.

Known limits: a nested navigation whose referrer the page withheld is judged
by the proxied top alone (the worker has no other way to its parent); the
policy upgrade-insecure-requests is remembered in the worker's memory, so a
worker restart forgets it until the document reloads; a fetch the policy
upgrades is fetched over https in the request's place, so its
`response.url` reads the http URL (natively the request itself is upgraded;
not measured); a blocked iframe's window reads back as the window membrane decides (the
membrane agent's).

## Gaps left, most detectable first

1. **`navigator.serviceWorker` and FedCM are missing by default**
   (`'serviceWorker' in navigator` is false; `ServiceWorkerContainer`,
   `navigator.login`, `IdentityCredential` undefined). Since this baseline,
   a controller built with `serviceWorkers: true` (the demo's `?sw`) gives
   pages emulated service workers (docs/service-workers.md), which closes
   the feature test for a host that turns them on; the default, and the
   live demo, still lack it. FedCM is still deleted.
2. **Client hints**: Accept-CH and Critical-CH are not honoured, so a site
   that asks for high-entropy hints gets none (server-side detectable, and
   bot scoring uses it). The worker can read the values
   (`navigator.userAgentData.getHighEntropyValues` works in a worker), keep
   each real origin's accepted hints from its top-level responses, add them
   to that origin's requests (third parties by the page's delegation), and
   restart a navigation for Critical-CH.
3. **WebRTC** revealed the user's real IP next to the wisp server's: STUN
   is not proxied. Fixed: the browser never reaches a server or candidate
   the page chose and the page sees what a browser on a network that drops
   UDP sees (docs/webrtc.md, webrtc suite).
4. **Permissions**: the proxied frame has no `allow` list, so geolocation,
   camera, microphone and clipboard are denied at once (isolated mode also
   reports a permissions-policy violation, and `permissions.query` says
   denied); `storage-access` reads `prompt` where native reads `granted`. A
   host decision: allowing them grants the host's origin for every proxied
   site.
5. **Request fingerprint, live**: HTTP/3 SETTINGS and frame order are
   stomp-h3's, its Accept-Encoding over HTTP/3 is `gzip, br`; ECH is never
   used (epoxy sends GREASE ECH only); https to an IPv6 literal fails in
   epoxy.
6. **`document.hasFocus()`** is false after a navigation from the demo's
   address bar (natively the page gets focus): the demo could focus the
   frame after navigating.
7. **WebSocket**: a close the server starts reads 1000 whatever its code
   (epoxy never reads the frame).

## Owned elsewhere (noted, not fixed here)

- Same-origin policy (docs/same-origin-policy.md): `fetch(..., {mode:
'no-cors'})` to another origin reads `basic` where native reads `opaque`
  (seen from the mixed-content fixture's http page; the suite does not
  compare the type); a cross-origin worker script's error reads its
  message where native mutes it to NetworkError (`importScripts` of a
  script that throws); `navigator.storage.estimate().quota` counts the
  host origin's usage; the storage-access permission answer above.
- Window membrane: the window of an iframe whose navigation was blocked as
  mixed content throws SecurityError on `location.href` (natively it stays
  same-origin `about:blank`).
- `cookieStore` is missing in both modes (being fixed by its own owner).
- `style` attribute readback, the Location stand-in's names, constructor
  descriptors and the `Audio` constructor: no browserleaks page showed a
  difference from them.
