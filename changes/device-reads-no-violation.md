### Fidelity

- A frame the browser refuses usb, hid or serial reads `navigator.usb`,
  `hid` or `serial` with no permissions policy violation, as natively. The
  device hooks listened for connect and disconnect on the object at its
  first read, and a listener where the feature is refused is a violation:
  a console message and a report to the page's ReportingObserver for each
  feature. Cloudflare's script reads all three in figma.com's Vimeo
  player. The hooks no longer listen where the browser refuses the
  feature, where no device connects. (device-reads suite.)
