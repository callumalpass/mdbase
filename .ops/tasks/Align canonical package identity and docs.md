---
title: Align canonical package identity and docs
due: '2026-02-27'
priority: high
tags:
  - packaging
contexts:
  - core
projects:
  - '[[projects/mdbase]]'
status: open
recurrenceAnchor: scheduled
dateCreated: '2026-02-19T11:51:26.259Z'
dateModified: '2026-02-19T11:51:26.259Z'
type: task
---
Problem:
- README import examples and package naming create ambiguity for first-time users.

Acceptance criteria:
- One canonical install/import path is documented.
- Quickstart works in a clean temp project.
- CI includes a docs smoke test that runs the quickstart snippet.
