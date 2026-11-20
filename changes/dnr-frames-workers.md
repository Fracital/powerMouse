### Fidelity

- A frame keeps its extension frame id when its parent sets its src, also
  when the document it leaves is an image. The new document takes the
  frame's id and parent once it reports.
- A dedicated worker's requests and sockets are in its page's tab and
  frame for declarativeNetRequest and webRequest. Before, its requests
  had tab id -1.
- Main frame navigations that no hooked document announced no longer mix
  their matched rules when they overlap. Each one's go to the tab its own
  document reports in.
- webRequest's onBeforeSendHeaders now sees the request headers before
  declarativeNetRequest changes them, as in Chrome. A listener's change
  that conflicts with a rule's is dropped whole, and onSendHeaders sees
  the headers that go out.
