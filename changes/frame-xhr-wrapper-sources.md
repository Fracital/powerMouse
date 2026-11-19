### Performance

- A proxied frame's first `XMLHttpRequest` opened with a method the browser
  sends as written (`GET`, `POST`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`,
  `PATCH`) no longer makes the deferred part of XHR's argument checks: the
  part's answer for such a method is the method itself. Any other method
  (lower case, an unknown token, a forbidden one) still goes through the
  part, with the browser's errors.
- A wrapper's source is noted as it is made without calling the realm's
  hooked `Function.prototype.toString` and checking the native's source
  twice: the hook's answer is read where the hook would read it. Each
  frame makes some 600 wrappers, and the duplicated work made the code hot
  enough to be optimized again in every frame. Together about 2 to 4 KB
  less heap a proxied frame (frame-cost, 20 frames, Chrome 157).
