### Performance

- More hooks of one kind call one shared function, which reads which
  member it was called as from the native it wraps: Resource Timing's
  restricted times and strings, a Response's type, opaque members and
  body methods, CSSStyleSheet's and the grouping rules' methods,
  SecurityPolicyViolationEvent's URL fields, NamedNodeMap's methods, the
  selector methods, the CSS rules' `style`, the FedCM credential getters,
  PublicKeyCredential's statics and `location`'s URL parts.
