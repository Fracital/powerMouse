### Origin isolation

- A RemoteController works under a host page that sends no referrer
  (`Referrer-Policy: no-referrer`, or `same-origin` with the proxy on
  another origin). The controller frame took the host's origin from
  `document.referrer`: with none it threw on `new URL('')` when its
  `stomp-allowed-origins` listed origins, said it only works embedded when
  it did not, and `wait()` never settled. It now reads the parent's origin
  from `location.ancestorOrigins`, and in a browser without it asks the
  page and takes the origin the browser gives the page's answer. A page
  the frame refuses (one its meta does not list, or one of an opaque
  origin, which it can neither check nor answer) gets an
  `EmbedderRefusedError` from `wait()` at once, with the origin and the
  reason. remote-embedder covers both policies and the three refusals.
