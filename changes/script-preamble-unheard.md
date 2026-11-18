### Fidelity

- A page's MutationObserver hears nothing of the source a classic inline
  script's first statement puts back in its element, and runs after the
  script's own promise reactions, as natively: the source was put back
  where the script stood, a childList record of the script's text no
  native script makes, and its mutation queued the observers' microtask
  ahead of the script's reactions. It is now put back from a microtask
  queued as the script starts, with no observer hearing of it, and the
  script reads back as written until then. (script-checkpoint suite.)
