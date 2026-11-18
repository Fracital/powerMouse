### Performance

- A read of `top`, `parent` or another frame's window with the site pool
  off is about half its cost: the top a window walked up to is kept while
  the window's parent is the one it was found from, the stand-in brand's
  symbol is made once, and a group that never held a window across a
  fresh context skips the lookup of one. 20,000 reads of `top` in a frame
  of another site went from about 30 to 14 ms (2.6 natively), of
  `parent.top` from 67 to 35 ms (8.8 natively), measure-hooks on Chrome 157.
