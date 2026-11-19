### Performance

- Wisp over WebTransport copies each byte the relay sends once, into its
  packet's own buffer. A relay's DATA packet is up to 128 KiB, and over the
  network the session's stream gives the reader chunks of about 4 to 9 KiB
  (5 to 9 KiB on average from stomp.fracit.al), so the bytes held so far
  were copied again with every chunk of a packet. Reading 100 MB from
  stomp.fracit.al took the loop 470 ms of the thread's time and now takes
  60 (about 4.7 ms a megabyte before, so more than half a core at
  1 Gbit/s), and a plain HTTP download through a local holyWisp went from
  1.5 to 2.2 Gbit/s on Chrome 157.
