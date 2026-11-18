### Fixes

- A quoted url() in a custom property written in a style's text by script
  (`el.style.cssText = ...`, `el.style = ...`) keeps its value and the
  declarations after it, as natively. The url() was routed twice, and the
  second time took the routed URL for the page's, so the routed URL read
  back from the property and the declaration after it was lost (with two
  custom properties, both). A cssText write is routed once now, and text
  routed already is found whole when it is routed again.
  (custom-property-csstext suite.)
