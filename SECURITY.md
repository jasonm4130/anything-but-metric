# Security

Report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/jasonm4130/anything-but-metric/security/advisories/new). Avoid posting credentials, exploit details or private measurements in public issues. Include the affected route, a minimal reproduction and the impact you observed.

The public API requires server-side Turnstile verification and applies input and request-rate limits. Turnstile helps control abuse; it does not prove a request came from the site's interface. Cloudflare credentials and the Turnstile secret belong on the server. The public Turnstile site key is intentionally visible in the built page.

Models propose comparisons and estimate sizes; Jev checks them; code owns every displayed number and the arithmetic, and renders model text only as plain text after a number-match check. Model estimates are labelled as estimates. None of this makes measurements suitable for safety-critical or engineering use.

Verified requests, including the measurement text and model responses, are kept in a private D1 replay log for 30 days to improve prompts and models. IP addresses and Turnstile tokens are not stored there.

Only the current `main` branch is maintained. This project has no guaranteed security response time or paid bug-bounty program.
