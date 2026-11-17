### Fixes

- A form whose `action` is a URL the URL parser rejects (`http://%zz/`,
  `http://[::1/x`, `https://`, `//:0/x`) no longer aborts the whole page
  with "Failure loading Stomp HTML" when the document's markup is loaded:
  the action stays as written and submits nothing, as natively
  (`adversarial-parse-html`).
