### Origin isolation

- A pageswap event's `activation` is null when the document set out for
  another site and was redirected back to its own, as Chrome has it for a
  cross-origin redirect. The outgoing page read the full URL another site
  sent its visitor on to (an OAuth code in the query, say). `pageswap`
  compares a same-site navigation, a cross-site one and a cross-site
  redirect back, natively and proxied.
