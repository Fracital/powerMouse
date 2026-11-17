### Fixes

- A navigation under the `origin` or `strict-origin` referrer policy sends
  its document's origin as the Referer, as natively; it sent none (WPT
  referrer-policy refresh-same-origin). (wpt-referrer-policy.)
