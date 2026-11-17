### Security

- A Document Picture-in-Picture window is injected as the requesting page's
  about:blank popup is, before the page gets it from `requestWindow()`,
  `documentPictureInPicture.window` or the `enter` event. Chrome opens one
  only for a top-level document, which a proxied popup the browser opened
  is: the window was an about:blank of the proxy origin with no inject, whose
  code read the proxy origin's storage and cookies (every site's) and whose
  written links pointed at the proxy. A proxied page in the host's frame is
  refused as a frame is natively (document-pip).
