# 0005. Install as an all-in-one app, without containers

- Status: Accepted
- Date: 2026-11-14

## Context

We looked at containers such as Docker as an easy way to line up the required parts (AI CLI, browser, daemon) in one go. Dool2's users are not developers. Installation has to be "for anyone, without a terminal, one touch".

## Decision

We do not use containers. Users install one Dool2 app, and Dool2 prepares the other parts by itself through official channels.

- Codex: on first use, download the pinned version from the official npm registry and install it only if it matches the **SHA-512 written in the code** (not bundled, to keep the installer small)
- Claude Code: Dool2 runs the same steps as the official install script (latest version → manifest checksum → download from the official distribution server → SHA-256 check → official `claude install`) on the user's behalf. It does not pipe a remote script into a shell, and it shows progress
- Chrome: if missing, install it from the official installer

A Docker image is offered only as an option for the Dool2 box and for people who want to self-host.

## Why

- Ordinary users do not know what a container runtime is. Installing Docker Desktop itself brings administrator rights, virtualization settings and licensing problems.
- Dool2 has to work with the user's **real Chrome and real desktop apps** (KakaoTalk PC, certificate windows). That cannot be done inside a container.

## Consequences

- Dool2 has to handle OS differences (paths, permissions, power settings) itself.
- We need a self-check and a [Fix] button that revives broken parts (M1).
