### Performance

- An address typed in an isolated host (RemoteController) no longer waits
  100 ms before its request goes out. The host's frame sends no referrer, so
  the worker waited for word from a document that started the navigation,
  which never comes for the user's own; the controller now tells the worker
  first. Measured from the address bar to the next page's first script:
  139 to 147 ms before, 32 to 46 ms after.
