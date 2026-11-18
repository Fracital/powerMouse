### Build

- The client hints' table of features (`src/server/hintNames.ts`) is made
  from the list of hint names when it loads, `ch-` and the name without its
  `sec-ch-`, instead of being written out by hand.
