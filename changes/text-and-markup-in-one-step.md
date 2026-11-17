### Fixes

- `element.textContent = value` on anything but a script or a style is the
  browser's own setter again, and `element.innerHTML = markup` replaces the
  children in one step. Both removed the children one by one and then
  appended, so a page's MutationObserver got a record per removed child
  and one more for the new nodes where natively it gets one record,
  `textContent = undefined` wrote the text "undefined" where natively it
  empties the element, a `remove` the page had defined on a child or on a
  prototype ran for every child, and each write paid for the loop.
  (wpt-dom-insertion suite: Node-textContent, MutationObserver-textContent,
  MutationObserver-childList, MutationObserver-inner-outer.)
