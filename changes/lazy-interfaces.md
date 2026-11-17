### Security

- A page that took `Geolocation.prototype.getCurrentPosition` (or
  `watchPosition`) before it first read `navigator.geolocation` called the
  browser's own method, which asked for the proxy origin's permission, the
  one every proxied site shares: a site the user had blocked read the
  location a host allowed. The `Geolocation` interface is now an accessor
  until first read, which hooks it first (src/inject/dom/lazyInterface.ts,
  the WebGL interfaces' way, now shared), and reads as the data property it
  natively is. permissions and sop-escapes check it against Chrome.

### Performance

- The 2D contexts' and the bitmap renderer's interfaces
  (`CanvasRenderingContext2D`, `OffscreenCanvasRenderingContext2D`,
  `ImageBitmapRenderingContext`) are hooked the first time a context of
  the kind is handed out or the name is read, as WebGL's are, instead of in
  every frame: a frame that never draws no longer makes them. A method taken
  from a prototype before any context exists is the hooked one, and the
  names read and list as natively (sop-escapes).
