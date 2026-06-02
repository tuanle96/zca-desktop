# ⚠️ Disclaimer & Risk Notice

**Read this before installing, building, or using zca-desktop.**

## Unofficial & unaffiliated

zca-desktop is an **independent, unofficial** project. It is **not** affiliated
with, endorsed by, sponsored by, or connected to **Zalo**, **VNG Corporation**,
or any of their subsidiaries. "Zalo" and related marks belong to their respective
owners and are used here only to describe interoperability.

This software talks to Zalo through the unofficial
[`zca-rust`](https://github.com/tuanle96/zca-rust) client, which relies on
private, undocumented endpoints that are **not** part of any public Zalo API.

## Account risk — use at your own risk

Using an unofficial client carries **real and material risk to your Zalo account**,
including but not limited to:

- **Temporary or permanent account suspension / ban.**
- **Forced logout** of your session or other devices.
- **Loss of access** to messages, contacts, or account data.
- **Rate limiting, captchas, or verification challenges** triggered by automated
  or non-standard traffic.
- Breakage at any time if Zalo changes its endpoints, payloads, or anti-abuse
  systems.

Behavior that resembles automation, bulk messaging, or spam **significantly
increases ban risk**. This project is intended for **personal, low-volume,
human-paced use only**.

## Terms of Service

Using an unofficial client **may violate Zalo's Terms of Service**. You are solely
responsible for determining whether your use complies with all applicable
agreements and laws in your jurisdiction. If you do not accept this risk, **do not
use this software.**

## No warranty / no liability

This software is provided **"as is", without warranty of any kind**, express or
implied. To the maximum extent permitted by law, the authors and contributors
**accept no liability** for any damages whatsoever — including, without limitation,
banned or suspended accounts, lost data, lost access, or any direct, indirect,
incidental, or consequential damages — arising out of the use of or inability to
use this software. See the [LICENSE](./LICENSE) for the full terms.

## Credentials are bearer tokens

Your Zalo credentials (`imei` + `cookie` + `userAgent`) are **bearer tokens**:
anyone who obtains them can act as you. This project stores them in your operating
system keychain and **never** logs, prints, or transmits their values to any third
party. **Never** share credential exports, paste them into issues, or commit them
to version control.

---

By using this software you acknowledge that you have read and understood this
notice and that **you assume all risk** associated with its use.
