# Security Policy

## Scope

zca-desktop is an unofficial, personal-use Zalo client. It handles **sensitive
credentials** (`imei` + `cookie` + `userAgent`) that act as **bearer tokens** for
a user's Zalo account. Security issues — especially anything that could expose,
leak, or mishandle these credentials — are taken seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report privately using one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), **or**
- Email the maintainer: **justin.le.1105@gmail.com** (use a subject line starting
  with `[zca-desktop security]`).

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce or a proof of concept.
- Affected version / commit, OS, and configuration.
- Any suggested remediation, if you have one.

**Do not include real credentials, cookies, or personal message content** in your
report. Redact anything sensitive.

## What to expect

- **Acknowledgement** within a reasonable time (this is a solo, volunteer
  project — please be patient).
- An assessment of severity and a plan for a fix.
- Coordinated disclosure: please give the maintainer a reasonable window to
  release a fix before any public disclosure.
- Credit in the release notes if you'd like it (and the fix warrants it).

## Out of scope

Because this is an unofficial client built on undocumented Zalo endpoints, the
following are **expected limitations, not vulnerabilities**:

- Account bans, suspensions, or logouts caused by Zalo's anti-abuse systems.
- Breakage when Zalo changes its private endpoints or payloads.
- Risks inherent to using an unofficial client (see [DISCLAIMER.md](./DISCLAIMER.md)).

## Handling of credentials

- Credentials are stored in the **operating system keychain** only.
- Credential values are **never** logged, printed, or transmitted to third
  parties.
- The repository `.gitignore` blocks credential export files (`*.cred.json`,
  `cookies.json`). If you ever find a credential committed to history, treat it as
  compromised, rotate it immediately, and report it privately.
