### Fidelity

- A target=_blank link (or a modifier or middle click) whose click a
  listener of the page cancels opens nothing, as natively: the host opened
  it as a new tab before the page had the click. Discord's channel links
  are target=_blank links its router cancels and routes itself, so every
  channel switch opened the channel in a new tab, which read as the whole
  page reloading (and in a call, as the call dropping). The link is opened
  once the click has gone through the page, which reads `defaultPrevented`
  and `returnValue` as its own calls left them, as a same-origin download
  already was (`src/inject/dom/heldClicks.ts`, spa-nav).
