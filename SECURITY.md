# Security and privacy

This repository contains only the standalone T3 Code / Chat on Steroids ACP bridge source and synthetic tests. It must never contain an installed user's CoS profile, local control API endpoint/token, T3 settings, SQLite session data, conversation transcripts, browser cookies, private keys, or generated provider registration.

- The bridge uses authenticated localhost control; no ChatGPT or CoS token belongs in source control.
- Installation writes immutable releases and private state outside the repository under the current Windows user's LocalAppData.
- Run npm run audit:public before committing, packaging, or publishing.
- Publish from a fresh audited Git root. Never publish development Git history that may include personal author emails, credentials, or local paths.
- The scanner checks known secret formats, emails, private artifacts and host paths, but cannot prove absence of all sensitive data. Inspect files and commit metadata before making a repository public.
- Report potential security issues privately to the repository maintainer, not in a public issue with credentials attached.
