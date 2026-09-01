# Architecture and transaction boundaries

## Components

| Component | Responsibility | Trust boundary |
| --- | --- | --- |
| AgentMail | Inbox, threads, delivery events, reply-all | External provider; every webhook is signature-checked |
| Worker fetch handler | Validates and normalizes webhooks | Rejects invalid signatures, old timestamps, large bodies, other inboxes, and unsupported events |
| Cloudflare Queue | Buffers accepted events and retries processing | Dead-letters an event after the configured delivery limit |
| `SchedulerThread` Durable Object | Serializes one thread and stores checkpoints | One deterministic transaction state per AgentMail thread |
| Workers AI | Produces structured plans and plain-text wording | No provider tools; output is schema-checked and fact-checked |
| Cal.com | Returns slots and creates the booking | Booking authority; availability is rechecked before mutation |
| Google Calendar | Confirms the event Cal.com created | Read-after-write verification; does not create the booking |

## Scheduling transaction

1. AgentMail sends a signed event to `/webhooks/agentmail`.
2. The Worker verifies the raw request and queues a normalized event.
3. The queue routes the event to the Durable Object named for its thread ID.
4. The Durable Object reads its checkpoint and the latest AgentMail thread.
5. Workers AI returns a structured action: ignore, clarify, propose, or book.
6. Deterministic code validates dates, duration, timezone, lead time, requested windows, exclusions, and proposal-round state.
7. For proposals, Cal.com confirms which candidates are available.
8. For booking, the Worker checkpoints `create_started`, checks availability again, and asks Cal.com to create one booking.
9. The Worker reads the booking back from Cal.com and verifies the time, duration, purpose, attendees, metadata, destination calendar, and Google reference.
10. The Worker reads the Google Calendar event and verifies its identity, content, time, attendees, and Google Meet URL.
11. Only then does AgentMail send the confirmation in the original thread.

An uncertain booking result moves the thread to `quarantined`. The Worker records the known booking UID when available and tells the owner to review the thread before any retry.

## Configuration boundaries

`src/scheduler-config.ts` contains public deployment choices. Cloudflare secrets contain credentials. Cal.com contains availability policy and booking limits. Do not duplicate a Cal.com policy in the model prompt unless deterministic code must enforce it independently.

## Deliberate constraints

- The public template supports 15, 30, 45, and 60-minute event types.
- The default lead time is 24 hours.
- The default limit is two automatic proposal rounds.
- Cal.com creates the event and meeting link.
- Google Calendar verification is specific to the current adapter.
- The system does not add a 15-minute buffer.
