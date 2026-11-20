### Demo and API

- `StompController.DEFAULT_ASSETS` gives the dist file names `init.assets` falls back to. The demo takes its file names from one `assets` setting (`globalThis.STOMP_ASSETS`, for a host that vendors `dist/` under names of its own): the service worker it registers and both controllers, with no bundle file name written into the UI.
