### Fidelity

- `import(url, options)` reads its options once, after the specifier is
  converted, as the browser's import does: a getter or a Proxy on the
  options (or on their `with`) ran twice. Found by test262
  (`import-attributes/2nd-param-with-enumeration-enumerable.js`).
