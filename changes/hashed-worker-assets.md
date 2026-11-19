### Performance

- The controller asks for the transport worker, the rewrite workers and the
  blocker's module by the hash of each file as built
  (`transportWorker.js?<hash>`, `rewriteWorker.js?<hash>`,
  `blocker.wasm?<hash>`), as it does the core module, and so isolation
  mode's frame and its script
  (`controllerFrame.html?<hash>&script=controllerFrame.js%3F<hash>`) and
  the site pool's frame script (`siteFrame.js?<hash>`), so a host may let
  browsers keep them for good. The demo server does, and names the rest of
  what a reload of its page used to revalidate the same way: the page's
  scripts, stylesheet and images (`/stomp/Controller.js?<hash>`,
  `/pm/main.js?<hash>`) and the transports, under the hash of their
  package's files (`/epoxy/<hash>/index.mjs`, a path segment so that
  epoxy.wasm and stomp-h3 beside it are under it too, config.js
  `transports`). A reload now revalidates the page, the service worker's
  script, the two images the stylesheet names and the favicon, where it
  revalidated some 20 files, and the transport worker's, the module's and
  its wasm's had come one after another: over a 40 ms link to the host the
  reload's first proxied byte came at 360 ms instead of 484 (a second tab
  at 331 instead of 596), and nothing changed on loopback. The plain names
  keep working, no-cache, and an old hash is served no-cache too, so a page
  of the build before a deploy is never told to keep the new file under it.
  (reload-revalidations.)
