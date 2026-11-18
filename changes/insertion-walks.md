### Performance

- An insertion walks only the nodes that land: insertBefore's reference
  child and replaceChild's old one were routed again, subtree and all,
  on every keyed move a framework makes, and an element moved again
  whose hooked attributes all have their originals skips the hooks'
  prototype swap.
