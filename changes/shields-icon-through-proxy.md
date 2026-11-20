### Security

- The demo's Shields panel no longer loads the site's icon on the host
  page. It showed the icon as a CSS background of the URL the proxied page
  declared, so the host page requested the real icon itself, outside the
  proxy, from the user's own address. The panel now shows the icon its
  tab's page fetched through the proxy, as a bookmark's is, and the globe
  until it has one. shields-icon checks the picture and that the host page
  made no request for it.
