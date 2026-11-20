### Fixes

- A FedCM account chooser closes when the document that asked goes (its
  frame removed, it navigated away), as Chrome closes its own, and the
  page's next request shows it again. It stayed drawn over the host's
  page, answering nothing: the worker and the host listened for the
  MessagePort close event, which Chrome 157 does not fire, even for a port
  closed explicitly. The document now says it goes on its pagehide (fedcm).
- A proxied page whose transport another tab serves (a routed link opened
  in a tab of its own) no longer waits for good once that tab closes: its
  open sockets end as a dropped connection (1006) and a new one fails at
  once, where an open one stayed OPEN and a new one CONNECTING. The serving
  side says it goes (TRANSPORT_GONE): serveTransport on its page's pagehide
  and when the host lets go of a port, the transport worker when the
  controller's page goes, and the service worker for a page's port no
  controller has (transport-host-gone).
