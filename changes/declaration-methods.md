### Fidelity

- An inline style's methods (`el.style.setProperty`, `getPropertyValue`,
  `getPropertyPriority`, `removeProperty`, `item`) are the prototype's own
  functions on every read and take the receiver they are called on, as
  natively. Each read was a new function bound to its element's declaration:
  two reads were not equal, their names read "bound setProperty", the
  constructor read as a bound one, `a.style.setProperty.call(b.style, ...)`
  wrote a's style, and the prototype's methods called on a page's
  declaration threw. The declaration-methods suite compares each with the
  page loaded natively. 20,000 `setProperty` calls went from about 20 to
  10 ms (3.7 natively), measure-hooks on Chrome 157.
