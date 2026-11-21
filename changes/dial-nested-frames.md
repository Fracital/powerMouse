### Fixes

- Dialing: a frame of a dialed document whose `contentWindow` or
  `contentDocument` the page read before the frame was dialed is dialed
  all the same. The read injected the frame's initial about:blank, whose
  window the browser keeps for the call page of the same origin, so the
  call page ran in the page's realm, hooks and all, refused its call, and
  the frame was never written and fired no `load`. Until its document is
  written such a frame now reads as another origin's (its document null,
  its window's members SecurityErrors), never a window that runs nothing
  of the proxy's; the next read after it is written gives its window
  (natively the window read early is that window already).
- Dialing: a dialed document's `load` waits for its frames' documents, as
  natively. The call page's own load was over before the frame's document
  was asked for, so the page's `load` fired with its frames still empty and
  a read of a frame's window there (`frame.contentWindow.navigation`) threw
  "Blocked a frame with origin ...". While a frame is called before its
  document has loaded, the document loads an image the worker holds
  (`?hold=` on the call page's path, no element and no timing entry of the
  page's) until the frame's document has loaded or its call ended. On a
  hard reload a frame's call now comes before the page's load is over, so
  the frame's document goes past the caches too, as natively. A
  document under a policy of the page's (which could refuse the image and
  report it) is not held.
- A hard reload's document whose shell writes the page from its timer (a
  dialed document, written into its call page) no longer tells the worker
  its load is over at the shell's own load, before the page had asked for
  anything: a dialed frame's scripts on a hard reload went to the caches.
