### Fidelity

- A module the rewriter cannot rewrite ends with an export of `eval`, a name
  no module can declare, which the browser refuses once it checks the
  module's exports, instead of the private name a classic script's end has,
  which it refuses while parsing. So a module the browser refuses for its own
  duplicate export, or for an export of a name it does not declare that sorts
  before `eval`, is refused with the browser's own SyntaxError ("Duplicate
  export of 'z'") where the page read "Private field
  '#STomp_could_not_rewrite_this_script' ...", and a module the browser would
  run is still refused (rewriter-unit, early-errors, module-errors).
