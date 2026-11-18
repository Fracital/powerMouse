### Fidelity

- In a frame no service worker controls (an about:blank frame a page
  builds or writes into), the images and other loads of markup the
  browser parses after the inject rewrote it load, as natively: those of
  `setHTMLUnsafe`, the Unsafe markup insertion members
  (`appendHTMLUnsafe`, ...), a shadow root's `innerHTML`, a declarative
  shadow root in such markup and execCommand's `insertHTML` and
  `insertImage` were left with no URL and never loaded (blank-creator).
