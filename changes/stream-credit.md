### Performance

- A body read slowly holds back only its own stream when the wisp server
  offers stream credit (Wisp extension 0xE2, holyWisp's `stream-credit`)
  and epoxy runs Wisp v2 (`wisp_v2`), as a native socket's receive window
  holds back only its remote. Each TCP stream's reader in epoxy grants the
  server what it consumed plus a window (256 KiB, grown as TCP autotunes
  up to 16 MiB; deploy/epoxy patch epoxy-tls 0084), and the server stops
  reading that origin alone: with a tab reading 128 MB at 8 MB/s, the
  origin wrote 10 to 16 MB past it where it wrote the whole body before,
  and the slow tab's transport worker grew 3 to 9 MB. With credit on, the
  carrier host never pauses its relay for one slow tab, and a rider hands
  epoxy its packets as they come (128 MiB past the readers at most, a
  backstop); a relay without it is paced as before. (stream-credit
  suite.)
