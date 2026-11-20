### Fixes

- Polling a frame's window while it navigates to another origin no longer
  restarts its navigation. Between commit and the frame's first script,
  the parent checks which URL committed and leaves a foreign window for
  the frame's own client. The frame can then finish loading and read its
  own fetch, XHR and worker responses.
