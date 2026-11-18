### Fidelity

- `webkitMatchesSelector()` matches an attribute selector by the attribute
  as the page wrote it, as `matches()` does (an `<object>`'s `data` while
  its copy loads); `Object.getOwnPropertyNames(el.attributes)` names an
  attribute a hook dropped; `getAttributeNodeNS`, `hasAttributeNS` and
  `removeAttributeNS` of no namespace, and the attribute map's
  `getNamedItemNS`, `removeNamedItem` and `removeNamedItemNS`, no longer
  find or remove the inject's marker attributes (object-documents).
