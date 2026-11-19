### Transport

- An HTTP/3 request the server acknowledged and whose answer is then lost
  goes over the base transport at Chrome's time, 21.4 s, where it waited
  for the 30 s idle timeout. stomp-h3 sends Chrome's keep-alive, a PING
  15 s after the last packet heard while a request is open and none while
  the connection is idle (measured in headless Chrome 157), and a PING
  that goes unanswered for the blackhole delay closes the connection as an
  unanswered request does; the origin is then marked broken. A PING goes
  as Chrome's 29-byte packet, the PING alone, where quinn's carried an ACK
  frame and its stateless reset padding (35 bytes). Needs the
  EpoxyTransport build with stomp-h3's keep-alive (deploy/epoxy,
  quinn-proto 0004 and 0005). (http3-fallback suite.)
