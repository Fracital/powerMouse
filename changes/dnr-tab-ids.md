### Fidelity

- declarativeNetRequest gives requests their tab. A main frame's own
  request is in the tab `frame.go()` sent it to, or in the tab of the
  document that started it. A frame's request is in its parent's tab, so
  `tabIds` conditions, getMatchedRules by tab and the action count badge
  now see these requests. Before, they were tab -1.
- A nested frame's parent is now the document that set its src, or, for a
  frame that navigated itself, the frame's parent. It used to be the
  latest document of the origin the navigation came from.
- onRuleMatchedDebug gives a tab's top document frame id 0 for its own
  requests, and 0 as the parent frame id of its frames.
- A click on an extension's button grants it activeTab for the tab until
  the tab's top document changes, which getMatchedRules reads.
