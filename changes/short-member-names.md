### Build

- The clients' and modules' own members (`wrapFunction`, `getModule`, the
  attribute hooks' `getAttributeOG` and 167 others, `scripts/memberNames.mjs`)
  are names of two or three characters in every bundle: the document bundle
  is about 14 KB smaller. The build fails on a listed name a bundle still
  holds (read by its name).
