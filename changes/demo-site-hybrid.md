### Demo and API

- The protected demo site (`npm run build:demo-site`) builds again: vibeOS's
  copy of the bookmark icons is served under a neutral name, and its 2048
  page's link is neutral. The public deploy builds it and serves it
  (`STOMP_DEMO_SITE=build/demo-site`); a build that fails the leak gate fails
  the deploy. The server reads its `.env` before `STOMP_DEMO_SITE`, which
  it had read first, so a site named there was never served; a relative
  path is the checkout's.
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
- The protected site shows the commits and the repository links again. It
  had shown "No commits yet", and its Fork us on GitHub and repository links
  went to github.com: the server sent no commits to it, so that no answer
  named the project. Each answer is now its JSON XORed with a key of its
  own, sent beside it, which the page decodes.
- A browser that visited the plain site, or another protected build, no
  longer mixes that build's bundles with this one's (a dial page answered
  404): each protected build names its bundles by hashes of its own, so a
  bundle kept as `immutable` under the hash of another build is never asked
  for, and the build fails when a plain hash is left in it.
- A page of a new protected build no longer waits for STomp's service worker
  (Chrome showed "Waiting for the service worker..." after a deploy for
  about 30 seconds): estrogen renames the messages between them in every
  build, so the earlier build's worker never answered it, and registering
  the same script URL again checks for no update. The page asks for the
  update as it registers the worker, and the controller binds to the new
  one as it activates.
- The protected site keeps what HSTS remembered across deploys: its
  database is among the stores whose name estrogen keeps the same.
