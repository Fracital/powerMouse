### Demo and API

- The protected demo site (`npm run build:demo-site`) builds again: vibeOS's
  copy of the bookmark icons is served under a neutral name, and its 2048
  page's link is neutral. The public deploy builds it and serves it
  (`STOMP_DEMO_SITE=build/demo-site`); a build that fails the leak gate fails
  the deploy.
- The code that runs for every proxied page stays out of estrogen's VM:
  STomp's runtime, the transports, Tor's client and vibeOS's games take its
  literal pool and name passes instead, every string encrypted and every
  name renamed. In the VM a proxied page took 7 to 12 times as long as with
  the plain demo; this way it takes about 1.6 times as long. The demo's own
  page and its other scripts stay in the VM, and the leak gate holds each
  file to its protection (`--outside-vm`).
- The rewriter library's file is protected one statement at a time, each
  on a line of its own with its strings' pool inside its function, so a
  frame that evaluates a deferred part from its text has the pool too (it
  threw `ReferenceError` on a page with frames, such as a Google search).
  The runtime finds a statement that assigns its name bare as well as one
  that assigns it on globalThis.
