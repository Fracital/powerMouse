### Fixes

- Extensions' content scripts run in the documents of the site pool's
  slots and of dialing's content slots, as on the hub's origin: an MV3
  extension's `content_scripts` and Tampermonkey's userscripts never ran
  there, since a slot's worker keeps no extensions. A slot's worker now asks
  the hub's worker for a document's scripts over a port the hub hands it
  (matched on the page's real URL, its frame and the site access), and
  carries the scripts and the contexts' storage calls; the slot's agent
  relays the extensions' channels of its origin to the hub, so
  runtime.sendMessage, tabs.sendMessage, ports and a user script's
  messages reach the background. A frame of another slot inside a dialed
  document reads its nesting from its call's route, so it is a frame of
  its tab and no longer reports itself as the tab's top. The
  ext-slot-content-scripts suite covers each run_at, both worlds,
  all_frames, exclude_matches and the messages, on the pool and on
  dialing's slots.
