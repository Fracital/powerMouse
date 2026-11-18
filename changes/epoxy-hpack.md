### Fidelity

- Epoxy's HTTP/2 header blocks are encoded as Chrome's are: every regular
  field and `:authority` indexed (Content-Length and Cookie were not, a
  `:method` such as PUT was), and a value Huffman coded only when that is
  shorter (short values such as `?0` went out coded).
