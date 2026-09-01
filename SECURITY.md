# Security

## Template status

This template contains no live credentials or identifiers from its source deployment. The example secret file contains variable names with blank values. Names and email addresses are synthetic, and the Cal.com event type IDs are deliberately invalid negative numbers. The deployment check fails until an adopter replaces those placeholders.

GitHub Actions runs the test suite and Gitleaks on every push. Anyone who adds real configuration must repeat the privacy checks before sharing an adapted fork.

## Credential handling

Never commit provider credentials. Production values belong in Cloudflare encrypted secrets. Local values belong in `.dev.vars`, which is ignored by Git.

If a credential is exposed, revoke it at the provider before rewriting Git history. History cleanup does not invalidate a live credential.

## Untrusted email content

Email is data, not authority. The planner prompt tells the model to extract scheduling facts only. Provider calls are implemented in deterministic code and use validated structured output.

The Worker:

- Verifies the raw AgentMail webhook body with Svix headers and a five-minute timestamp tolerance.
- Accepts only configured inbox events.
- Limits webhook payloads and provider response sizes.
- Uses a queue and one Durable Object per thread to serialize work.
- Checks recipients after every sent message.
- Stops on uncertain mutations rather than retrying a booking blindly.
- Confirms Cal.com and Google Calendar state before sending a booking confirmation.

## Data in logs

The Worker logs identifiers, state names, bounded error codes, and availability summaries. Review logging for your privacy requirements before production. Do not add full message bodies, credentials, OAuth responses, or full provider payloads.

## Publishing an adapted fork

Your fork may contain private information after you connect it to your providers. Before changing its visibility to public, scan its current files and complete Git history for:

- API keys, OAuth credentials, webhook secrets, and refresh tokens
- Personal email addresses and names
- Cloudflare account identifiers and production URLs
- Cal.com event type IDs and live booking identifiers
- Google calendar IDs
- Local absolute paths
- Test fixtures copied from real conversations

Keep the Gitleaks CI step enabled and run a local secret scan before publishing. If a scanner finds a real credential, revoke it first. Removing the value from Git does not invalidate it.

## Reporting a vulnerability

Open a private GitHub security advisory for the repository. Do not include active credentials, personal email content, or live booking data in a public issue.
