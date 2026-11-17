### Origin isolation

- The legacy sandboxed file system (`webkitRequestFileSystem`,
  `webkitResolveLocalFileSystemURL`, their entries, and
  `webkitRequestFileSystemSync` in a dedicated worker) is partitioned per
  site. The browser keeps one per real origin, so every proxied site read and
  wrote the same files under names and URLs that named the proxy's origin:
  each site now has a directory of its own that every path is confined to
  (`..` stops at its root), the file system is named after the site's origin
  (`http_example.com_0:Temporary`), `toURL()` gives
  `filesystem:<site origin>/temporary/...`, the root reads as `/` with itself
  as its parent and refuses removal in Chrome's words, and a frame sandboxed
  to an opaque origin gets Chrome's `SecurityError`. `legacy-file-system`
  compares two sites natively and proxied, `adversarial-legacy-fs` tries
  every path, URL and realm to another site's file.
