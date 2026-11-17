### Fidelity

- A destructured parameter that reads through the access API stays in the
  parameter list: the pattern is bound from a plain parameter in a rest
  slot added at the end (`...{ $s$jp0: { top: t } = $s$j.pattern(...) }`),
  in the parameters' own scope. Moving it into the body as `var` let a
  sloppy function's `arguments` become mapped, gave a closure in a default
  the body's `var` of the same name, and let a block function in the body
  replace it. A function with a rest parameter still has the pattern moved
  into the body (`test/differential/corpus.mjs` KNOWN). A setter's
  parameter is never given a slot, since a setter takes exactly one. Found
  by test262 (`dstr/*-ptrn-prop-eval-err.js`, 15 runs).
