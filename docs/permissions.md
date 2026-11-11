# Permissions through the proxy

**Measured 2026-11-10 against Chrome 152 and 156, both demo modes**
(permissions suite).

## The trade-off

The browser keeps a permission per top-level origin, and to the browser
every proxied site is the proxy origin (in isolation mode, a frame of the
host's origin, whose permission Chrome delegates from the host). So the
browser has exactly one answer for all proxied sites: once the user lets
one site use the camera, the browser lets every proxied site use it, and
once the user blocks one, it blocks them all. STomp cannot give each site a
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
  would not ask again, and STomp never lets that grant pass to a site the
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
`getUserMedia` with NotAllowedError (when the device exists, see below).

The host's own frame decides what the proxy origin may ask the browser for
at all. In same-origin mode the proxied frame is same-origin with the host
and may ask for everything. In isolation mode it is a frame of another
origin, which gets nothing without an `allow` attribute: the demo sets one
on its frames (`FRAME_ALLOW` in demo/public/pm/main.js). Chrome never shows
a frame of another origin the notification prompt, so in isolation mode a
site's `Notification.requestPermission()` is dismissed (`default`).

## The order of a getUserMedia answer

Chrome answers `getUserMedia` in this order (measured in headless Chrome
152 and 156, identical on both: top level, a frame of another site without
`allow` and with it, with the permission undecided, granted and denied,
with a microphone and a camera, with no camera, and with neither):

1. Malformed constraints, and a request for neither kind: TypeError. A
   kind is asked for by `true` and any other truthy value, by any object
   and by `null` (a member that is null is an empty set of constraints:
   `{ audio: null }` opens the microphone); `false`, `0`, `''`, `NaN` and
   `undefined` ask for nothing. The constraints themselves may be any
   object, a function and `document.all` too, and each member is read
   once.
2. Audio, when asked for: no microphone is "NotFoundError: Requested
   device not found"; constraints no microphone satisfies are
   OverconstrainedError, its `constraint` the one that failed (`deviceId`
   before `groupId` before the rest), its message empty.
3. Video, when asked for, the same way.
4. The permissions policy: "NotAllowedError: Permission denied".
5. The permission: denied is the same NotAllowedError, undecided the
   prompt (headless Chrome denies it, and a denied request for both denies
   both).

A request that ends at 1 to 3 prompts nobody and changes no state, and the
answer is the same whoever asks:

| The request                                                        | Microphone and camera           | No camera                          | Neither       |
| ------------------------------------------------------------------ | ------------------------------- | ---------------------------------- | ------------- |
| `{ video: { mandatory: {}, width: 1 } }`, `{}`                     | TypeError                       | TypeError                          | TypeError     |
| malformed video, unsatisfiable audio                               | TypeError                       | TypeError                          | TypeError     |
| `{ audio: true }`                                                  | policy, then permission         | policy, then permission            | NotFoundError |
| `{ video: true }`, `{ audio: true, video: true }`                  | policy, then permission         | NotFoundError                      | NotFoundError |
| `{ video: { width: { min: 99999 } } }`                             | OverconstrainedError `width`    | NotFoundError                      | NotFoundError |
| `{ audio: { deviceId: { exact: 'nope' } } }`                       | OverconstrainedError `deviceId` | OverconstrainedError               | NotFoundError |
| the same with `video: true`                                        | OverconstrainedError `deviceId` | OverconstrainedError (audio first) | NotFoundError |
| `{ audio: true, video: { width: { min: 99999 } } }`                | OverconstrainedError `width`    | NotFoundError                      | NotFoundError |
| `{ audio: { groupId: { exact: 'nope' } } }`                        | OverconstrainedError `groupId`  | OverconstrainedError               | NotFoundError |
| `deviceId` and `groupId` both unknown                              | OverconstrainedError `deviceId` | OverconstrainedError               | NotFoundError |
| `{ video: { groupId: { exact: 'nope' }, width: { min: 99999 } } }` | OverconstrainedError `groupId`  | NotFoundError                      | NotFoundError |
| unsatisfiable only in an `advanced` set, or as an ideal value      | policy, then permission         | by the kinds, as above             | NotFoundError |

"Policy, then permission" is NotAllowedError for a frame its policy
refuses and for a denied site, the prompt for an undecided one, the stream
for a granted one.

Only the browser can make checks 1 to 3, and STomp's own answers (the
simulated policy, the site's state, the host's prompt) must come after
them. Calling the page's `getUserMedia` to learn them could prompt the
user or open the device. So the controller asks for it: its document (the
proxy origin, as the page is, so the device ids mean the same) makes the
request in a frame whose `allow` turns the camera and the microphone off
(`mediaVerdict` in src/controller/mediaVerdict.ts). Chrome gets as far as
its policy there and no further: NotAllowedError says checks 1 to 3
passed, any other error is the page's answer, with Chrome's own name,
message and `constraint`. Nothing is prompted for and no device opens.
The inject's `getUserMedia` then goes on to the page's policy, the site's
state and the host's prompt, and calls the browser last. A `groupId` is
one document's, so for the controller's frame a required `groupId`
becomes the `deviceId`s of that group's devices, and a failure of those
is reported as `groupId`.

Before, STomp answered with its policy and the site's state first: a
frame its policy refused and a site that was denied were told
NotAllowedError on a machine without the device (a CI runner has
neither), and for unsatisfiable or malformed constraints; a site the host
had to ask for showed the host's prompt for a request that could only
fail; and a page that read `permissions.query()` at once after a refused
request for both kinds could still read `prompt` for one of them.

Not every request needs the verdict, and three kinds get none:

- A request the browser's own call answers. A site that holds the
  permission, and one that neither STomp nor the browser has decided about
  (the browser's own prompt asks), go straight to the browser's
  `getUserMedia`, which makes checks 1 to 3 itself, in its order.
- A document the browser's own policy refuses every kind it asks for: the
  host's `Permissions-Policy` header, or the `allow` of a frame above the
  proxied page (`document.featurePolicy`, which no proxied page can
  widen). Such a page reads `denied` and is refused, as a page under that
  policy is natively, and the browser's call says so itself: it can
  neither prompt nor open a device there, its answer comes in Chrome's
  order, and its console line is the page's own, as natively. (Only when
  every kind is refused. With one of two refused Chrome's real permission
  path answers NotAllowedError too, but under
  `--use-fake-ui-for-media-stream` it opens the other kind, so that
  request takes the checks below.)
- Kinds with no constraints on them (`true`, `null`, any value that is no
  object). No such set is malformed and none can fail a device, so only a
  missing device ends the request before the policy, and
  `enumerateDevices` names every kind the browser has.

The controller's frame under a host's own headers. The frame is the
host's document's (the controller frame's in isolation mode), so the
host's headers are its headers. Measured in Chrome 152 and 156, an
`about:blank` frame whose `allow` turns both devices off, made by a
document served with each of these, is made and answers the three kinds
of request (TypeError, OverconstrainedError, NotAllowedError) in under
10 ms, with no `securitypolicyviolation` event:
`Content-Security-Policy: frame-src 'none'`, `child-src 'none'`,
`default-src 'none'` (Chrome applies none of them to an `about:blank`
frame), `sandbox allow-scripts allow-same-origin`,
`Permissions-Policy: camera=(), microphone=()`,
`Cross-Origin-Embedder-Policy: require-corp` and `credentialless`, with
and without `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options:
DENY`, `frame-ancestors 'none'` and `require-trusted-types-for 'script'`.
Under `sandbox` without `allow-same-origin` the document has no origin
and reading its own frame throws: there is no verdict, at once (and no
service worker either, so no proxy). No header makes a page wait on the
controller's 4 s or the inject's 6 s. The suite asks `mediaVerdict` in a
document under each header, and runs the top-level and frame cases
through a demo behind a server that adds a Content-Security-Policy, a
sandbox and a Permissions-Policy to every document (`demoBehind` in
test/lib.mjs). Under an embedder policy no proxied page loads at all
today (the worker's documents do not send the header Chrome then
requires of a frame), so there only the frame itself is covered.

Limits. The verdict costs one round trip to the controller per request
that needs one, and the controller makes them one at a time. Chrome logs
"Permissions policy violation: microphone is not allowed in this
document." (or camera) as an error in the console of a document whose
policy refuses a request, for every request that is not a TypeError (one
that ends in OverconstrainedError too), so each verdict leaves that line
in the console of the controller's document, the host page or in
isolation mode the controller frame; a host whose `Reporting-Endpoints`
name a default group is sent the report. There is no way to the same
answer without the line: Chrome writes it when the request is made, in
any frame its policy refuses (a sandboxed one, one removed at once, which
then never answers), and a frame its policy does not refuse would prompt
or open the device. So the line is left only for a request with
constraints on a kind, from a site that was refused, a frame the page's
policy refuses, or a site the host is asked about. Natively the line is
in the refused page's own console; through the proxy a frame the page's
policy refuses (and the browser's does not) has none.
Constraints that are not plain data (a function, a symbol) get no verdict,
and neither does a page whose controller does not answer within 6 s:
then STomp looks for the devices itself (`enumerateDevices` names every
kind the browser has, whatever the policy and the permission), answers
NotFoundError for a missing kind, and leaves the constraints to the
browser's own call, after the policy and the permission. `audio` and
`video` are read once, as natively; what is inside them is read once
more (a getter there runs again), and only its enumerable members go to
the controller. A request for both kinds whose policy refuses the
microphone only, from a site granted both, is "NotAllowedError:
Permission dismissed" in Chrome (a refused camera is "Permission
denied"); STomp says "Permission denied" for either.

The suite makes each of these requests as a site that has not been asked,
as one that was refused and in a frame its policy refuses, on the
machine's own devices and again in a Chrome launched with a microphone
and a camera (`--use-fake-device-for-media-stream`), with no camera
(`=device-count=0`) and with no microphone (`NO_AUDIO` in test/lib.mjs: no
PulseAudio server and an empty ALSA configuration; Chrome has no switch
for it), and as a granted site with fake devices.

## The devices a site reads

Measured in Chrome 152 and 156 with fake devices
(`--use-fake-device-for-media-stream`), natively:

- `enumerateDevices()` lists one entry per kind with an empty `deviceId`,
  `groupId` and `label` (and `getCapabilities()` of `{}`) until the site may
  use the device: the microphone permission shows the audio inputs and the
  audio outputs, the camera permission the video inputs, each without any
  `getUserMedia` call. A frame of another site reads them with its top's
  permission and its own `allow`, kind by kind.
- A `deviceId` is the origin's own: no two origins share one, a new
  document of the origin reads the same ones, and so does the origin in a
  frame of another site (the ids are the frame's origin's, not the top's).
  `default` is literal. A `groupId` is the document's: every document
  reads new ones. Another profile reads other ids, and in a profile on
  disk `Clear-Site-Data: "cookies"` resets the origin's (`"storage"` and
  `"cache"` do not; a private context never resets them).
- An id is taken only from its origin: `getUserMedia` and
  `applyConstraints` with another origin's `deviceId` or `groupId` as
  `exact` end in OverconstrainedError (as `ideal` it is ignored), an
  element's `setSinkId` in NotFoundError, an AudioContext's in
  "NotFoundError: AudioContext.setSinkId(): failed: the device ... is not
  found." A track's `getSettings()` and `getCapabilities()` name its device
  by the origin's ids, `getConstraints()` reads back what was written.
- Without the microphone permission an element's `setSinkId` of any id but
  `default` and `''` is "SecurityError: No permission to use requested
  device", and an AudioContext finds no device but `''` (`default`
  included). An AudioContext's output is a policy matter too: in a frame of
  another origin `setSinkId` is "NotAllowedError: Permissions-Policy
  disallows speaker selection." for any argument, on 152 whatever the
  frame's `allow`, on 156 unless it names `speaker-selection`.
  `selectAudioOutput` is not exposed.
- `devicechange` fires only where the site may read the devices that
  changed: an output plugged in is an event for a site with the microphone
  permission and for a frame allowed the microphone, none for a site that
  has not asked, one with the camera only, or a frame without `allow`.
  Chrome on Linux notices the new device when a page next lists the
  devices, and fires the event then. Fake devices never change, so this
  is measured, and the suite checks it, in a Chrome whose only sound
  server is a private PipeWire one without hardware
  (`launchPrivateSound` in test/lib.mjs: a mount namespace with `/dev/snd`,
  `/dev/video*` and the system bus hidden, a virtual microphone, and null
  sinks loaded with `pactl` as the outputs plugged in). Where no such
  server can be started (a CI runner has no PipeWire) that part of the
  suite is skipped. The camera-only case is measured by hand in the same
  Chrome (`grantPermissions(['camera'])`, no camera needed): the proxy
  cannot grant a site a camera that is not there.

To the browser every proxied site is the proxy origin, so before this was
handled a proxied page read the proxy origin's list:

| A proxied page                                                         | Before                                       | Now, as natively                              |
| ---------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| a site that has not asked, once any site was granted                   | every device, with labels and ids            | one nameless entry per kind                   |
| a site granted the microphone only                                     | the cameras too                              | audio inputs and outputs; one nameless camera |
| the deviceIds two sites read                                           | the same 5 of 5 (an identifier across sites) | none in common                                |
| `getUserMedia` with another site's id, `exact`                         | opens that device                            | OverconstrainedError                          |
| `setSinkId` with another site's output id                              | plays there                                  | NotFoundError                                 |
| `setSinkId` of a site that has not asked                               | any output                                   | SecurityError, or no device for a context     |
| a frame of another site without `allow`, its top granted               | every device                                 | one nameless entry per kind                   |
| the same frame allowed the microphone                                  | the cameras too                              | audio only                                    |
| that frame's deviceIds                                                 | its top's                                    | its own origin's, as at top level             |
| `devicechange` for a site that has not asked, or a frame without allow | fired                                        | not fired                                     |

What STomp does: a page reads ids made from the browser's with a salt of
its own origin (SHA-256, the same shape as Chrome's; the worker keeps the
salt in IndexedDB, an opaque origin gets a new one per document) and
groupIds made with a salt of the document. Ids are made on the way out
(`enumerateDevices`, `MediaDeviceInfo` and `InputDeviceInfo`, a track's
settings, capabilities and constraints, `sinkId`) and turned back on the
way in (`getUserMedia`, `applyConstraints`, `setSinkId`, `new
AudioContext({ sinkId })`); an id that is not the site's, the browser's
own included, names no device. What is listed follows the site's own
permission and the document's policy, kind by kind. An origin's salt goes
when the host wipes its cookies (`controller.cookies.clear(origin)`), the
nearest thing to Chrome's reset: `Clear-Site-Data` never reaches the
browser.

Limits. In isolation mode the proxied top is a frame of another origin
than the host: before Chrome 156 its AudioContext cannot choose an output
at all, and from 156 only when the host's frame allows `speaker-selection`
(the demo's does). A site that may read only one of the microphone and the
camera gets a `devicechange` the inject dispatches (`isTrusted` false)
when the devices it reads changed; a site that may read both gets the
browser's. An id a page kept from a visit, used in `new AudioContext({
sinkId })` before the document asked for anything else, is not known yet
and names no device (`setSinkId` and `getUserMedia` look it up).

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
