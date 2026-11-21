### Fixes

- Add to Chrome works when the host's page is itself in a frame of a page
  of its origin, as SystemYA shows the demo's UI under its own navbar.
  Before, every click answered "Download error: This function must be
  called during a user gesture". A proxied page posted its reports (where
  it is, its service worker client, its activation, a link that opens a
  tab) to the browser's top, which there is SystemYA's page and not the
  host's. The host never learned which frame the store's page was in, so
  the click's focus check failed. A proxied page now posts to the window
  that frames its outermost proxied document. Past a window of another
  origin it still posts to the browser's top, as before (webstore suite,
  framed host).
- The Web Store's install and uninstall dialogs read the click when the
  store's page calls, as Chrome takes the call's gesture with the call.
  Before, the worker downloaded the store's icon first and the host read
  the activation after it, so an icon that took longer than the
  activation's 5 s refused the click. A call with no click is still
  refused with user_gesture_required (webstore suite, an icon 6 s late).
