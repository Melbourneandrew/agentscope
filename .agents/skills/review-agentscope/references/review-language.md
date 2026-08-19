# Defensive review language

## Frame the work accurately

Begin security-sensitive reviews with a compact statement such as:

> Authorized defensive review of the local Agentscope repository and the named change. The goal is to verify trust boundaries and add regressions; no third-party target or credential access is requested.

This makes scope clear to collaborators and automated safety systems without weakening technical precision.

## Preferred terminology

- Use **adversarial regression**, **hostile input**, **trust-boundary bypass**, **authority confusion**, **unsafe mutation**, or **reproduction** when those are accurate.
- Reserve **exploit** or **attack** for a demonstrated security-impact path where that term materially improves understanding.
- Name the defensive invariant first: “credential-after-origin ordering bypass” is clearer than a generic “credential attack.”
- Say whether a reproduction is source-only, built-dist, local platform, synthetic, or inferred.

## Content safety

- Use synthetic canaries rather than real credentials or captured user content.
- Redact tokens in command output and do not paste secret-bearing errors.
- Keep review comments free of provider response bodies, endpoint query strings, local user paths, trace content, and native source identifiers.
- Prefer stable error codes, hashes, counts, and booleans as evidence.

## Do not euphemize defects

Clear defensive framing is not permission to dilute findings. If a change violates a trust boundary, destroys data, exposes a credential, or bypasses an approved authority, state that precisely and assign severity from demonstrated impact.
