### Fidelity

- A call used as an assignment target (`f() = 1`, `f()++`, `--f()`,
  `f() += x`, `for (f() in o)`, `(f()) = 1`) is rewritten instead of
  refused: V8 compiles it, calls `f`, then throws a ReferenceError before
  the right side runs, and the rewriter's parser now takes it the way V8
  does. Such a script used to be ended unrewritten with a SyntaxError, so
  none of it ran. `super() = 1`, optional calls, `new f()`, `import()` and
  tagged templates as targets are still refused, as V8 refuses them. Found
  by test262 (`assignmenttargettype/*callexpression*`, 60 runs).
