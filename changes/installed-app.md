### Demo and API

- powerMouse installs as an app in Chrome: `demo/public/manifest.webmanifest`
  (display `standalone`, Window Controls Overlay first, icons at 192, 512 and
  a maskable 512, shortcuts for New tab, Extensions and Settings,
  `web+stomp:` links, a share target, `launch_handler` `focus-existing`) and
  a worker of the site's root, `demo/public/app-worker.js`, which answers
  only the app's own page, and only with an offline page when the network is
  down; its static routes send every other request to the network without
  starting it, and STomp's worker keeps `/stomp/`. The menu has Install
  powerMouse while Chrome offers the app, and `theme-color` follows the
  theme. Only the top page at the site's root links the manifest and
  registers the worker, so a copy of the page in a frame or under another
  path is no app. demo/README.md "The installed app" lists which of
  Chrome's shortcuts reach the page in an app window; the `pwa` suite
  checks the rest headless.
