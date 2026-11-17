### Fidelity

- A `url()`, `image-set()` or `src()` whose name is written in upper case
  or with a CSS escape (`URL(`, `u\72l(`, `\55RL(`, `image-se\74(`) is now
  routed wherever a sheet or a style holds it, as Chrome reads the name
  with its escapes resolved and its case ignored; before, such a URL in a
  style sheet, a custom property or an at-rule prelude loaded from the site
  direct. The same holds for a `url()` left open at the end of a value and
  the strings of an `image-set()` or `src()` in a custom property or a
  `var()` fallback, and an `@import` named in upper case or with an escape
  (`@IMPORT`, `@\69mport`) now loads its sheet as a style sheet, where it
  was routed as an opaque file. An `@namespace`'s `url()` is a name, not a
  load, and is left alone (`adversarial-parse-css`).
