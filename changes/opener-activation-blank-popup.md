### Fidelity

- A popup opened without a URL that its opener sends on under user
  activation sends `Sec-Fetch-User: ?1` again, as in Chrome, which takes
  the activation of the document that starts the navigation. Since a
  navigation of a window still on its initial about:blank starts in the
  call, the proxy went by the popup's own activation, which is none, so
  the header was missing whenever a page opened a popup and sent it on
  from a later click. The activation is read in the call, so a popup
  opened and sent on in one task still sends none, as natively: the open
  consumes it. (navigation-initiator suite.)
