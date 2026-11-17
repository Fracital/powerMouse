### CI

- A `test262 differential` job runs test262's language, built-ins and
  annexB tests in node, natively and rewritten by STomp
  (`npm run test262`), and fails on a run whose verdict differs that
  `test/test262/known.txt` does not list, or on a listed one that no longer
  differs. The test262 commit is the one known.txt names, fetched as
  `test/` and `harness/` only and cached by its sha.
