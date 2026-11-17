### Performance

- The JavaScript rewriter (core.wasm) rewrites about 1.4 to 1.5 times as
  many bytes a second: on the bench's rewrite corpus 21 to 22 MB/s became
  30 to 37 offline in Node, and 20.7 became 29.3 in Chrome 157. The kept
  copy of a script's text that its functions read back is written in one
  pass that copies the runs between the characters it carries, where it
  went a character at a time over the whole script (a third of a rewrite's
  time); a string literal the rewriter writes, the UTF-16 offsets of a
  script with non-ASCII text and a script's key work a byte at a time the
  same way; the question of which functions' `arguments` a page may rebind
  is asked only of a script that reads `arguments` by a computed key; and
  the output is allocated once at its length. Every rewrite is byte for
  byte what it was (revision 16), and the module is 1,026 bytes larger
  (732 brotli).
