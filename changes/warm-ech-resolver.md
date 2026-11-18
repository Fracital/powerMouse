### Performance

- The transport opens its connection to the DNS-over-HTTPS server epoxy
  asks for a site's ECH config (`ech_dns`) along with its wisp connection:
  the first site's TLS handshake waited for a TCP and TLS handshake with
  the resolver first. A cold first load's first byte came 70 to 120 ms
  sooner (example.com 230 to 131 ms, MDN 226 to 154 ms, Wikipedia 285 to
  171 ms on loopback to the wisp server). (transport-init.)
