### Performance

- The document bundle's own copy of `navigator`, taken as it loads so its
  reads are the browser's whatever the page replaces, has only the members
  the bundle reads (`userAgent`, `sendBeacon`) instead of every member of
  `Navigator.prototype`. Binding all of them made each getter and method
  in every frame, which a native frame makes only when its page reads one:
  about 8 KB less heap a proxied frame (frame-cost, 20 frames on Chrome
  157, same site: 1,096.8 to 1,098.8 KB before, 1,088.9 to 1,091.6 KB
  after). The lint names a read of a member the copy lacks
  (eslint.config.mjs).
