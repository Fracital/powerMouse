### Performance

- A link the page writes is resolved against the base URL without two
  copies of it, and its visited route is sealed once per target: a
  rendered list's links cost about five URL parses and a seal each
  before.
