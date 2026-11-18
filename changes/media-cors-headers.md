### Fixes

- Another origin's video or sound loaded with `crossorigin` plays as
  natively. The service worker showed every cors answer of another origin
  only the headers CORS lets a page read, which is right for the page's
  own fetch and XMLHttpRequest (and its emulated service worker's fetch)
  but not for an element, which reads the whole response: a media
  element's Range request answered with a 206 and no Content-Range is a
  format error, so every crossorigin video on amazon.com's homepage failed
  with MEDIA_ERR_SRC_NOT_SUPPORTED. (media-cors suite.)
