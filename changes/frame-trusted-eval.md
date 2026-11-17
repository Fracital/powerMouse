### Fidelity

- A frame's `eval` runs a TrustedScript that another realm's policy made,
  as Chrome does (it asks the value's brand, not its prototype). Google's
  sign-in page runs its BotGuard program in a frame of its own
  (`/_/bscframe`) by calling that frame's `eval` with TrustedScripts its own
  policy made: `eval` returned them unrun, the page fell back to a string
  `eval` the frame's Trusted Types refuse, and the program never ran.
  (csp-trusted-types suite.)
