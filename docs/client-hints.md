# Client hints through the proxy

**Measured 2026-11-10 against Chrome 152, both demo modes** (client-hints
and client-hints-unit suites).

Every proxied site shares the proxy origin, so the browser's own client
hints are useless to them: it would keep a site's `Accept-CH` for the proxy
origin (every proxied site would then get the hints one site asked for),
restart the shell for a `Critical-CH`, and decide delegation in proxy URL
space, where every request is same-origin. The service worker therefore
drops the hints the browser added to a request and builds them itself from
Chrome's rules between the real origins (`src/server/clientHints.ts`). It
strips `Accept-CH` and `Critical-CH` from the shell it serves, and the inject
removes the content of a page's `<meta http-equiv="Accept-CH">` and
`delegate-ch` (the page still reads its own value), so the browser never
acts on them for the proxy origin.

## What Chrome does, and the worker with it

| Behaviour                                                     | Chrome 152 (measured)                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A top-level response's `Accept-CH`                            | kept for its origin; applies at once to that document's subresources and same-origin frames, and to every later navigation to it                                                      |
| A later top-level `Accept-CH`                                 | replaces the set; a blank one clears it; a response without one keeps it                                                                                                              |
| `Accept-CH` of a frame or a subresource                       | ignored                                                                                                                                                                               |
| `Critical-CH` naming an accepted hint the navigation lacked   | the navigation is made once more with the hints (a second request)                                                                                                                    |
| A subresource of another origin                               | the high-entropy hints only when the document's `Permissions-Policy` delegates their `ch-*` feature to it (default `self`)                                                            |
| `sec-ch-ua`, `-mobile`, `-platform`                           | every secure request (policy default `*`)                                                                                                                                             |
| A frame's navigation                                          | decided in the browser process by the main frame's policy for the frame's origin, with the iframe's `allow` attribute on top                                                          |
| A frame's subresources                                        | the main frame origin's kept set, under the frame's inherited policy and its own header                                                                                               |
| `<meta http-equiv="Accept-CH">`, static or inserted by script | the top-level document's own later subresources only: not its frames, not kept, ignored in a frame                                                                                    |
| `<meta http-equiv="delegate-ch">`, parsed                     | enables the hint for the document and delegates it to the named origins, frames included; inserted by script it does nothing                                                          |
| Values                                                        | the browser's userAgentData, device memory and network estimate; the main frame's viewport for a navigation, the requesting frame's own for a subresource (0, so none, before layout) |
| Field order                                                   | a navigation in the browser process's fixed order; a subresource in Blink's header map hash order (`src/server/blinkHeaderMap.ts`)                                                    |

The worker reads userAgentData, `deviceMemory` and `navigator.connection`
itself. `sec-ch-ua`, `-mobile` and `-platform` are the browser's own, as it
sent them to the proxy origin; a browser that sends none to a secure proxy
origin has its user-agent hints off (a DevTools user-agent override without
metadata, as Playwright's `userAgent` option sets), and then the site gets
no `sec-ch-ua*` hint at all. The pixel ratio, the media preferences and each document's
viewport come from the pages (`CLIENT_HINTS`, the ClientHints inject
module) and, before any page reported, from the controller: its own window
at the handshake, and a frame's size when `frame.go()` navigates it. A
frame's `allow` attribute travels with the navigation hint its parent sends
when it routes the frame's `src`.

## Left

- `Sec-CH-Width` / `Width` (an image's rendered width with `sizes`) is never
  sent: the worker does not know the element's layout.
- A worker's requests (dedicated, shared, service) carry the default hints
  only, and so does a document the worker served before it restarted.
- An `allow` attribute set after `src` is not seen: the navigation hint
  carries the attribute as it was when the page set `src`.
- `rtt` and `downlink` are rounded with the noise Chrome keys on the proxy
  host, not on the site's.
- A scripted `Accept-CH` meta is applied a task after insertion, so a
  request the parser started just before it may or may not get the hints.
