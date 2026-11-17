### Fixes

- `element.setAttribute(name, value)` with a name that is not a valid
  attribute name (`'0'`, `'a^b'`, `''`) throws the browser's
  InvalidCharacterError, as natively. An attribute no hook watches is
  written by the inject, which caught the error and logged it, so the page
  saw the call succeed and nothing set. (wpt-dom-insertion suite:
  attributes.)
