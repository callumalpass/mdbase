# Spec Notes

This file documents known spec bugs/clarifications that required code adjustments in this repo.

- SN-041 (Type name length): max valid length is 64 characters. Implementations must reject names with length > 64 (not >= 64).
- SN-048 (replace semantics): `.replace()` with a string pattern replaces ALL occurrences; regex patterns only replace all when the `g` flag is used.
- SN-050 (link/tag extraction): link and tag extraction must exclude indented code blocks (4+ spaces or a tab). Escaped wikilinks (`\[[`) must not be parsed as links.
