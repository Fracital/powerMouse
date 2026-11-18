### Fixes

- With the site pool on, a frame of another slot than its page's no longer
  leaves `__stompPasskeys`, `__stompActivation` or `__stompDeferred` as
  globals of its page. The frame took its deferred statements from its
  slot's agent as one text running from the parts' statement to the end of
  the file, whichever one it asked for, so evaluating it assigned the
  others. The agent now keeps each statement by its name, and the frame
  asks for the one it needs. This showed in a frame's first deferred part
  (an XMLHttpRequest's checks) and in a frame that starts with an
  activation the proxy gave it.
