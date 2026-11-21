### Fixes

- The home page's commit list no longer asks GitHub's avatar host for each
  author's avatar (with the author's email in the address, from every
  visitor): the demo's server fetches each once, at the size shown, keeps it,
  and serves it under a neutral directory by a name that says nothing. With
  `STOMP_GITHUB_API=off` the rows go without avatars (`demo-bookmarks`).
- offline.html's commit list has no avatars (an empty span in each row): with
  no server of its own, each would be a request from the visitor's machine to
  GitHub's avatar host. The build no longer reads the authors' emails
  (`offline-html`).
