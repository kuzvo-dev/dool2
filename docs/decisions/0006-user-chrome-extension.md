# 0006. Use the browser through the user's own Chrome plus the Dool2 extension

- Status: Accepted
- Date: 2026-11-14

## Context

Dool2's most important promise is "never get blocked on Korean services". The options we looked at:

| Option | Problem |
|---|---|
| Launch a new Chromium with Playwright | Logins reset every time, and automation traces trigger bot detection |
| Attach remote debugging to the user's Chrome | Since Chrome 136, remote debugging is blocked on the default profile |
| An external AI browser or a Chromium fork | The user has to log in again in a new browser, and maintaining a fork is costly |
| Import cookies from the existing browser | Risky for security and easy to break because of OS keychain encryption |

## Decision

Install the **Dool2 extension in the Chrome** the user already uses, and connect it to the Dool2 daemon with native messaging. Input is sent as real input events through `chrome.debugger`. We settle on Chrome as the one browser, and Dool2 installs it if it is missing. A dedicated-profile mode is kept as an option for those who want it.

## Why

- It uses the user's usual logins, so there is no need to log in again, and since it is a real user's browser it gets blocked the least.
- For an extension, you can check that the public code and the store build are the same.
- We can only support the skills and tests if we settle on one browser.

## Consequences

- Installing the extension needs one user click (allowing an "external extension").
- CAPTCHAs and identity verification are not bypassed. The screen is handed off to the person.
- Because this works on the user's browser, we review extension permissions and message validation as a security-critical area.

## Revisited (2026-11-14): should we switch to our own Chromium-based browser?

We also reconsidered the approach of building a browser from scratch on Chromium for AI work. Its advantages are that it gives full control over the whole browser, controls screen and input without permission prompts, and can fit screens such as the vault and the task panel naturally into the browser.

**We still keep the default option.**

| Point considered | Own Chromium browser | User's Chrome + Dool2 extension (current) |
|---|---|---|
| Usual logins | Cookies must be imported from the existing browser. On Windows this is practically blocked by Chrome's app-bound encryption, and Korean sites easily see it as a "login from a new device" and ask for verification again | Works exactly as the user usually does |
| User habits | The user has to switch browsers | No need to switch |
| Security updates | We would have to follow Chromium security patches ourselves every 2 to 4 weeks | Google does it |
| Installer size and signing | We ship one more browser | One extension |
| Security programs of banks and public sites | May need to be reinstalled and recognized per browser | Used as already installed |

What we take from it is recorded as separate decisions.
- A vault where Dool2 fills in passwords without showing them to the AI → [ADR 0011](0011-login-vault.md)
- A screen for choosing the permission level per task (read-only / protected / full) and a "final check" switch → reflected in the approval gate (M3) screen
- A **dedicated-profile mode** (running Chrome with a separate data folder, no fork) for cases where the extension is not enough stays as an option
