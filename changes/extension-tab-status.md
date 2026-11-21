### Fixes

- An extension's tab is `complete` once its page has loaded, as in Chrome:
  a tab could stay `loading` for good (tabs.query, tabs.onUpdated), so
  Tampermonkey's coloured per-tab icon and its document-idle userscripts
  never came. The top document now tells the host its own load (its
  readyState), which a called frame's element (dialing) never fired again
  and a report that came after the load missed. An extension's background
  and pages under a site pool are shown from the hub's origin; on a slot
  they had no extension runtime and never started.

### Fidelity

- tabs.onUpdated and webNavigation follow Chrome 157 across a link,
  pushState, a fragment, Back and Forward within and across documents, the
  page's reload and the browser's: DOMContentLoaded at the document's,
  `url` only when it changed, no title told for a traversal or reload that
  shows the entry's own, `favIconUrl` once a navigation (while loading for
  such an entry, after `complete` otherwise; tabs.query lost it after
  every navigation), `forward_back` and `client_redirect` qualifiers and a
  traversal's own transition. The ext-tab-status suite compares them with Chrome's own,
  the probe loaded natively over CDP.
