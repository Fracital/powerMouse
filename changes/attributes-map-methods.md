### Fixes

- The methods of `element.attributes` are NamedNodeMap's own, as natively:
  `element.attributes.item === NamedNodeMap.prototype.item`, and its
  iterator is `Array.prototype.values`. The view that hides the inject's
  marker attributes answered with functions of its own (`item`,
  `getNamedItem`, `setNamedItem`, a generator for iteration) or bound
  copies of the rest; the prototype's methods now act on the view when it
  is their receiver. (wpt-dom-insertion suite: attributes-namednodemap.)
