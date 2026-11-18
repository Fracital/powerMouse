### Fixes

- A script whose text holds nearly every control character keeps reading
  back as the page wrote it. Its functions' sources come from a copy of the
  text written into the routed script, where six characters the text does
  not hold stand for the ones a comment cannot carry; they were picked only
  from the ASCII controls, so a script holding all but four of them (the
  string tables of the obfuscated anti-fraud sensors on NPR and Bank of
  America) got no copy, and `toString` and `String()` of every one of its
  functions gave the rewriter's output. Those sensors take their decoding
  keys from their own functions' sources, decoded garbage, and threw a
  `TypeError` (`... is not a function`) on every proxied load. The stand-ins
  now go on into the private use area. The rewriter's revision is 18.
  (function-source suite.)
