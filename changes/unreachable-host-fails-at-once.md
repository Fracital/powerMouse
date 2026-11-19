### Fidelity

- A request to a host that cannot be reached at all, a name that does not
  resolve or an IPv6-only name on a network without IPv6, fails about as
  soon as natively instead of after a second. The wisp server refuses such
  a stream as it refuses one it throttles, and epoxy reports both the same
  way, so the transport backed off and tried four more times (50, 120, 250
  and 500 ms) before the page heard: a `.invalid` fetch took 930 ms through
  STomp and 1 to 5 ms in Chrome. The transport now asks the wisp server
  about the destination on a UDP stream beside the first wait, one per host
  and port however many requests were refused, and fails the request when
  the close reason says unreachable (0x42, or wisp-js's 0x03); a throttled
  stream (0x49) or a host the server reaches is retried as before.
  Cloudflare's challenge times such a fetch (its IPv6-only probe host
  brunhild.challenges.cloudflare.com), which now fails in about 30 ms
  through a local holyWisp. (unreachable-host and reviving-transport
  suites.)
