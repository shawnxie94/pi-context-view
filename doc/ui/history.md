# Context History and Failures

`/context history` and `/context failures` are separate fullscreen accounting
views. Both read only the current Pi session's versioned history custom entries;
opening either view must not resolve Initial, run the silent probe, or request a
model response.

## Context History

Show four distinct groups:

1. Request count, with requests missing provider usage called out as unknown.
2. Provider-reported input, cache-read, cache-write, output, and total tokens.
3. Cumulative estimated context categories, labeled with `≈`.
4. Tool-source attribution overlays, labeled as estimates and explained as
   subsets that overlap the category estimates.

Provider usage and character-based estimates are separate accounting bases;
never combine them into a single total. Source attribution includes only
recognized agent-brain command calls and selected document reads, and is an
estimated subset of request context.

## Context Failures

Show hard tool failure count, immediate same-input retry count, estimated
failure request/result footprint, and estimated retry-call input footprint.
Where present, show token estimates by tool source. Explain that estimates may
overlap provider usage and do not prove avoidable waste. Only explicit `isError`
tool results count as failures; semantic failures are not inferred.

## Layout and interaction

- Use one selectable, scrollable list with section headers and value rows.
- Values are right-aligned when space permits; at narrow widths, truncate the
  label before allowing any line to exceed the terminal width.
- Up/Down, `j`/`k`, PgUp/PgDn, Home, and End navigate; Escape or `q` closes.
- Preserve border and hint rows under short terminal heights. Descriptions may
  collapse as a whole; provider/estimate labels and the estimate caveat must
  remain available in the view content.
- The selected row uses accent foreground without a background. Section names
  use bold `mdHeading`; estimates use `≈` and remain distinct from provider
  values.
