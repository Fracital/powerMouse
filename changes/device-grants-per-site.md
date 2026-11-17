### Security

- WebUSB, WebHID, Web Serial and Web Bluetooth devices are each site's
  own, in documents and workers: `getDevices()` and `getPorts()` list what
  the site chose, another site's device fires no `connect` or
  `disconnect`, `forget()` forgets for the site, a Bluetooth device's `id`
  is the site's and its GATT server reaches only the services the site
  named, with Chrome's SecurityError otherwise. Before, a site listed the
  device another site chose, read that site's id for it, reached the
  services it named, and its `forget()` took the device from both. The
  demo's frames allow the four, which isolation mode refused. (bluetooth-grants, with
  Chrome's emulated adapter; USB, HID and Serial by code.)
