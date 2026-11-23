### Performance

- A first visit is about 60 ms sooner (230 against 289 ms in the bench):
  `new StompController()` takes the promise `StompController.register()`
  returns, unawaited, as `init.serviceworker`, and starts its transport,
  rewrite workers and modules while the worker installs; and the check of
  whether a waiting page stops the others (which a new worker asks at its
  first handshake, and a first document waits for) is measured meanwhile.
  The README, the minimal host example, the demo and the bench host pass
  the promise.

### Demo and API

- `ControllerInit.serviceworker` may be the promise `register()` returns:
  `controller.serviceworker` is unset until it resolves, and `wait()`
  rejects if it fails.
