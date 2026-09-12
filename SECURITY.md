# Security

Report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/jasonm4130/anything-but-metric/security/advisories/new). Avoid posting credentials, exploit details or private measurements in public issues. Include the affected route, a minimal reproduction and the impact you observed.

The public API requires server-side Turnstile verification and applies input and request-rate limits. Turnstile helps control abuse; it does not prove a request came from the site's interface. Cloudflare credentials and the Turnstile secret belong on the server. The public Turnstile site key is intentionally visible in the built page.

Model output is restricted to an offered comparison ID. Code owns displayed facts and arithmetic. This boundary reduces the model's authority; it does not make measurements suitable for safety-critical or engineering use.

Only the current `main` branch is maintained. This project has no guaranteed security response time or paid bug-bounty program.
