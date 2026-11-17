### Origin isolation

- With the site pool on, a site's `forget()` of a Web Bluetooth, USB, HID
  or Serial device no longer takes the device from another site that
  chose it. Each slot's worker kept the sites' devices in a store of its
  own, so it could not see that a site of another slot still held the
  device and forgot it in the browser, which keeps it for the host's
  origin, the top of every slot. The devices are now kept in the host
  origin's one store, as permission states are.
