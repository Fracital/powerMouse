### Transport

- An HTTP/3 connection that has sent a request and hears nothing back is
  closed at Chrome's blackhole delay (6.4 s on loopback, measured in Chrome
  157), where stomp-h3 waited for its 30 s idle timeout, and a request whose
  connection failed under it marks the origin broken once the base
  transport answered it, as Chrome marks an alternative broken after its
  retry without alt-svc. A QUIC path that carried the handshake and then
  nothing (a WebTransport carrier's UDP flow lost while the session lived)
  held every request to that origin for the idle timeout, each reconnecting
  and waiting again. A request the server acknowledged whose answer is
  then lost still waits for the idle timeout (Chrome's 15 s PING finds it
  in about 21 s; stomp-h3 sends none), and then marks the origin broken.
  (http3-fallback, webtransport-wisp suites.)
