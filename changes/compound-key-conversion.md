### Fidelity

- An object that is a computed key of a compound assignment or an update
  (`o[k] += v`, `o[k]++`, `o[k] ||= v` that assigns) is converted to a
  property key as often as V8 converts it, twice: the access API converted
  it once. Found by test262 (`topropertykey-once`, `S11.3.2_A6_T3` and
  the like, where V8 differs from the specification and Chrome is the
  oracle); the rewriter-differential cases that listed it as known now
  match.
