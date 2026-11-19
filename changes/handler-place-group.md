### Performance

- A frame whose markup has a handler attribute (an `onclick`) evaluates
  only the code that finds the handler's place in the markup, not all of
  the violations' code with it: about 7 KB less heap a frame (1101 to
  1094 KB with one onclick, 1084 KB with none; Chrome 157).
