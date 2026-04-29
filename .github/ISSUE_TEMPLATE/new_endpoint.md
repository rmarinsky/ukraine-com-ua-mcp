---
name: New endpoint support
about: Request (or propose) wrapping an unsupported adm.tools endpoint
title: "[endpoint] "
labels: enhancement
---

## Endpoint

- **Action path**: `dns/...` <!-- e.g. dns/auth_code_get -->
- **Method**: POST
- **Form fields**: `id`, … <!-- list with types -->

## Why

<!-- One-paragraph use case. "I want to migrate registrar so I need EPP auth code" is a good example. -->

## Source

<!--
Where did you find the field names? Examples of acceptable sources:
- The official PHP reference: https://github.com/ukraine-com-ua/API
- The community PHP wrapper: https://github.com/kudinovfedor/ukraine-api
- Your own successful POST captured via mitmproxy / curl. If so, paste the
  redacted request and response below.
-->

## Sample response

```json
```

## Destructive?

- [ ] Yes — costs money, deletes data, or changes external delegation
- [ ] No — read-only or trivially reversible

If destructive, describe the rollback path so the tool description can guide
the model.

## Are you working on it?

- [ ] Yes, opening a PR
- [ ] No, hoping someone else picks it up
