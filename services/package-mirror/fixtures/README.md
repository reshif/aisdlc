# Package mirror fixtures

The directory the package mirror serves, read-only, to sandboxes that may install packages (classes K-exec, W and
O). It is EMPTY on purpose: the mirror is a stub until the real wheels and npm tarballs are chosen (DEC-17). A
package manager pointed at it fails closed (404), which is what a probe with no mirror content should do.

Files placed here are served verbatim under `/<path>`; `/index.json` lists them with their sha256.
