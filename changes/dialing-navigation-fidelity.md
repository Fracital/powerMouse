### Fidelity

- In dialing, a fragment navigation that replaces its entry
  (`location.replace('#x')`, or `navigation.navigate()` with
  `history: 'replace'`) leaves `history.state` null, as Chrome 158 and 159
  do for every fragment navigation; the page's state used to stay. A dialed
  page's frame reads `navigation.activation.from` as the entry its
  navigation left when that entry is of its origin, as the tab does (it
  was always null in a frame). A frame's `navigate` event shows no
  `sourceElement` for a link or form of another origin's document aimed at
  it by name: every proxied document is of one real origin, so the browser
  showed the parent's element. In wpt-navigation-api-dial eleven pages pass
  now (navigate-history-state, navigate-history-state-replace,
  sourceElement-cross-origin, the cross-site click and submit
  same-document pages and six of navigation-activation/), and its expected
  list drops 6 entries for them and 23 that pass on Chromium 158 and 159.
