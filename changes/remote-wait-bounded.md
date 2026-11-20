### Origin isolation

- `RemoteController.wait()` no longer waits forever on a controller frame
  that fails to load. Chrome shows a frame it blocked as an error page and
  fires its load event, and the host page's ReportingObserver hears why, so
  `wait()` rejects with a `ControllerFrameError` that names the cause: the
  proxy origin's `frame-ancestors` (quoted) that does not list the host's
  origin, or a host page that sends COEP while the frame's response has no
  `Cross-Origin-Resource-Policy` or no embedder policy of its own. A frame
  that loaded and said nothing (a 404, a wrong directory or asset name)
  rejects 5 s after its load event with the causes it could be, and one
  that never loads after 60 s. remote-frame-failures covers the four
  cases.
