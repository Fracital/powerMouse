# Permissions through the proxy

**Measured 2026-11-10 against Chrome 152, both demo modes** (permissions
suite).

## The trade-off

The browser keeps a permission per top-level origin, and to the browser
every proxied site is the proxy origin (in isolation mode, a frame of the
host's origin, whose permission Chrome delegates from the host). So the
browser has exactly one answer for all proxied sites: once the user lets
one site use the camera, the browser lets every proxied site use it, and
once the user blocks one, it blocks them all. Stomp cannot give each site a
real permission of its own. What it does instead:

- **Each site has its own state**, kept by the service worker in IndexedDB
  by the real origin of the proxied top (Chrome delegates a frame's
  permission to its top-level site, so a frame shares its top's).
  `permissions.query()` and `Notification.permission` show the page that
  state, as a real `PermissionStatus`; a `change` the browser fires for the
  proxy origin's own permission never reaches the page.
- **A request reaches the browser's API only for a site that may have it**:
  the site was granted before; or neither the site nor the browser has
  decided, and the browser's own prompt asks the user (its answer becomes
  the site's).
- **When the browser already holds the permission for another site**, it
  would not ask again, and Stomp never lets that grant pass to a site the
  user did not answer for: the host asks the user in its own UI
  (`onPermissionRequest` on `StompController` and `RemoteController`;
  resolve true, false or null). Without a host prompt the request is
  dismissed and the site stays undecided.
- **When the browser has denied the proxy origin** (the user blocked one
  site), no site can get the permission; a request fails and the
  site's own state does not change.

What this costs: the browser's prompt names the proxy origin, not the
site, the first time any site asks; a site the user granted stops working
when the user blocks the proxy origin in the browser's settings (its state
still reads granted); and two sites asking for the same permission at the
same moment while the browser has not decided get one prompt, so the
second is dismissed rather than given the first one's answer.

## The policy

A page's permissions policy is simulated too: the worker records each
document's `Permissions-Policy` header (the browser never sees it) and, for
a frame, its element's `allow` attribute (sent with the frame's navigation
hint) under its parent's policy. A frame of another site gets geolocation,
the camera, the microphone, the clipboard and the other powerful features
only when its `allow` names them, and never notifications, as natively;
there `query()` reads `denied`, `getCurrentPosition` fails with "Geolocation
has been disabled in this document by permissions policy." and
`getUserMedia` with NotAllowedError.

The host's own frame decides what the proxy origin may ask the browser for
at all. In same-origin mode the proxied frame is same-origin with the host
and may ask for everything. In isolation mode it is a frame of another
origin, which gets nothing without an `allow` attribute: the demo sets one
on its frames (`FRAME_ALLOW` in demo/public/pm/main.js). Chrome never shows
a frame of another origin the notification prompt, so in isolation mode a
site's `Notification.requestPermission()` is dismissed (`default`).

## What it covers

| Permission                                                                                                                                                | Shown per site | Request gated                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| geolocation                                                                                                                                               | yes            | `getCurrentPosition`, `watchPosition`                |
| camera, microphone                                                                                                                                        | yes            | `getUserMedia`                                       |
| notifications (and push)                                                                                                                                  | yes            | `Notification.requestPermission`                     |
| clipboard-read, midi, persistent-storage, local-fonts, idle-detection, window-management, display-capture, captured-surface-control, local-network-access | yes            | no: the browser's API is called as the page calls it |
| clipboard-write, screen-wake-lock                                                                                                                         | policy only    | no                                                   |
| the rest (sensors, background-sync, payment-handler, storage-access, ...)                                                                                 | the browser's  | no                                                   |

Before, the host's frame had no `allow` list: in isolation mode the
browser denied the proxied page every powerful feature at once
(`PERMISSION_DENIED`, a permissions-policy violation, `query()` reading
`denied`), and in same-origin mode every site shared whatever the user
answered for any of them.
