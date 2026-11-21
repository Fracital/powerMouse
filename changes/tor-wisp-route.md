### Transport

- Add an opt-in Tor route for proxied TCP traffic through a dedicated Wisp relay backed by Tor SOCKS5. The homepage Tor checkbox remembers the choice, isolates its service worker data and refuses to fall back to direct Wisp when the relay is unavailable. UDP and HTTP/3 are disabled in Tor mode.
