# Phase 1 Public Inputs

Checked during Phase 1 desktop implementation. No provider credentials are
included in this file. These checks do not constitute authenticated API tests.

## Model Metadata

The user selected endpoint `https://api.deepseek.com` and model
`deepseek-v4-flash`. The official [first API call documentation](https://api-docs.deepseek.com/)
was opened in the browser and lists that endpoint and model name. The page
describes OpenAI-compatible and Anthropic-compatible API formats.

The generic web tool returned no readable result; this observation is from the
official page rendered in the browser. No credential was entered in that page,
no authenticated model request was made, and no runtime adapter is part of
Phase 1. Exact schema/tool/stream behavior remains a Phase 5 contract test.

## Photography

Local image files are retrieved from Wikimedia Commons thumbnail endpoints.
Their file titles, creators, source pages and license metadata were read from
the Commons `action=query` API (`imageinfo` with `extmetadata`).

The attribution manifest is [`public/image-credits.json`](../../public/image-credits.json).
It is served with the application so photo credits remain inspectable. Photos
are illustrative venue images, not Evidence for opening hours, route duration,
availability, accessibility, or current appearance.

The app renders images locally and therefore does not require Wikimedia or
other external requests at runtime. Broken-image tests must still produce
accessible placeholders. The original user screenshots remain under `ref/`;
their pixels are not redistributed as application assets.
