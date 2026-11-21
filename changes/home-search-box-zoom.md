### Fixes

- The home page's search box keeps its width while the home screen zooms
  back in (Home, Back at the start of a tab's history, leaving the tab
  manager, closing the last tab), for example after the Extensions page,
  Settings or Shields were open in a tab. On a window 768 px or wider the
  box is absolutely positioned and was sized from the card, but the zoom
  transforms the search form, and a transformed element is the containing
  block of its absolute descendants. For the zoom's 260 ms the box was
  50 px narrower, with a 60 px gap before Go instead of 10 px, and then it
  snapped back. The form is now the box's containing block at all times,
  and the box is sized from it, so nothing changes when the zoom runs. The
  settled layout is the same at every width. (demo-extensions suite.)
