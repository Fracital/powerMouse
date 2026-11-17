### Fidelity

- `super[k]` reads and writes check `this` before `k` is evaluated, and
  convert the key when V8 does: a write converts it after the right side
  runs, a compound write converts it before and after. A key's `toString`
  ran first and once. Found by test262
  (`assignment/target-super-computed-reference*.js`, 12 runs).
