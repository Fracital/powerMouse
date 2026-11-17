### Fixes

- An about:blank or srcdoc frame that mints blob: URLs no longer stays in
  memory after it is removed: the inject's table of the Blobs behind
  minted URLs, which its creator's bundle keeps, held the frame's Blobs and
  with them its realm. Each realm keeps its own now, and the table names
  them weakly, as the browser drops a document's URLs with it
  (frame-churn).
