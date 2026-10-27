---
status: accepted
---

# SafeNet AI: separate application with a persistent task queue

The expanded October 2026 specification asks for Next.js, FastAPI, PostgreSQL,
Celery/Redis and four public-source monitors. The working Express/React SafeNet
KZ deployment and its Telegram evidence are preserved while the new application
is built under `apps/console` and `services/intelligence`.

Four persisted agents share a small collector interface. Tasks are atomically
claimed before collection; every visible stage is emitted by actual code. A
blocked source has no score. Human input, historical imports and synthetic
examples retain explicit provenance. Demo and live counts are queried separately.

The Python detector is a **new ruleset**. Its fixture tests are regression tests,
not the old blinded evaluation. Old SafeNet metrics (85.5% / 74.7%) must not be
attributed to this engine. The old holdout remains untouched.

For a local Windows run, SQLAlchemy SQLite and a bounded four-thread executor
allow a working application without Docker. Production uses PostgreSQL and
Redis/Celery in Compose. The runtime identifies which adapter is active.

LLM explanations are optional and cannot increase risk scores or invent source
evidence. Browser Use autonomous navigation is not enabled: the provided
Playwright path only renders public HTML already obtained through IP-pinned,
size-bounded HTTP. It runs without page JavaScript or independent network access.
This deliberately limits dynamic-only pages; the application exposes that limit.

An admin cookie protects mutations. Local automatic admin is opt-in and the
provided development launcher binds both processes to loopback. Production
requires a separate secret admin code, exact allowed origins and HTTPS cookies.
Saved content is minimized, card/phone values are redacted and data expires after
the configured retention period. No browser profile credentials are imported.

Sources: [Celery Redis](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html),
[FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/),
[Browser Use browser controls](https://docs.browser-use.com/open-source/customize/browser/all-parameters).
