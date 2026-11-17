### Fixes

- An about:blank or srcdoc frame that loads a script no longer stays in
  memory after it is removed: the table of the texts scripts hand over for
  their functions' sources, which the frame shares with its creator, held
  the script's holder, a function of the frame's realm. The table holds
  holders weakly now and each realm keeps its own (frame-churn).
