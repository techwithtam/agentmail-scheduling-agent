import { DurableObject } from "cloudflare:workers";
import { emptyState, failureAlertDetails, failureAlertKey, processQueueEvent, sendFailureAlert, type QueueEvent, type ThreadState } from "./scheduler";
import { assertConfigured, schedulerConfig } from "./scheduler-config";
import { SerialTaskQueue } from "./serial-task-queue";

const ACCEPTED_EVENTS = new Set([
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
]);
const MAX_QUEUE_DELIVERIES = 4;

function nestedRecord(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["message", "send", "delivery", "bounce", "complaint", "reject"]) {
    const value = payload[key];
    if (value && typeof value === "object") return value as Record<string, unknown>;
  }
  return payload;
}

function firstString(records: Record<string, unknown>[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key]) return String(record[key]);
    }
  }
  return "";
}

function eventEmails(payload: Record<string, unknown>): string[] {
  const nested = nestedRecord(payload);
  const candidates = [nested.recipients, nested.recipient, nested.to, payload.recipients];
  const values: string[] = [];
  for (const candidate of candidates) {
    const entries = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    for (const entry of entries) {
      if (typeof entry === "string") values.push(entry.toLowerCase());
      else if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const email = String(record.email ?? record.address ?? record.recipient ?? "").toLowerCase();
        if (email) values.push(email);
      }
    }
  }
  return [...new Set(values)].sort();
}

function normalizeEvent(payload: Record<string, unknown>): QueueEvent {
  const nested = nestedRecord(payload);
  return {
    eventId: firstString([payload], ["event_id", "webhook_id"]) || firstString([nested], ["event_id", "id"]),
    eventType: firstString([payload], ["event_type", "type"]) || firstString([nested], ["event_type", "type"]),
    inboxId: firstString([nested, payload], ["inbox_id"]),
    threadId: firstString([nested, payload], ["thread_id"]),
    messageId: firstString([nested, payload], ["message_id", "id"]),
    recipients: eventEmails(payload),
    reason: firstString([nested, payload], ["reason", "error", "description"]),
  };
}

function decodeSigningSecret(secret: string): Uint8Array {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function verifyAgentMailSignature(request: Request, body: string, secret: string): Promise<boolean> {
  const messageId = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signatures = request.headers.get("svix-signature");
  if (!messageId || !timestamp || !signatures || !secret) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeSigningSecret(secret);
  } catch {
    return false;
  }
  const rawKey = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new TextEncoder().encode(`${messageId}.${timestamp}.${body}`);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return signatures.split(" ").some((entry) => {
    const [version, encoded] = entry.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    try {
      const actual = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      return constantTimeEqual(expected, actual);
    } catch {
      return false;
    }
  });
}

export class SchedulerThread extends DurableObject<Env> {
  private readonly processing = new SerialTaskQueue();

  process(event: QueueEvent): Promise<void> {
    return this.processing.run(() => this.processSerially(event));
  }

  private async processSerially(event: QueueEvent): Promise<void> {
    let state = await this.ctx.storage.get<ThreadState>("state") ?? emptyState();
    state = await processQueueEvent(this.env, state, event, async (next) => {
      await this.ctx.storage.put("state", structuredClone(next));
    });
    await this.ctx.storage.put("state", state);
    const alert = failureAlertDetails(state, event);
    if (alert) {
      const key = failureAlertKey(alert);
      if (!(state.alertedFailureKeys ?? []).includes(key)) {
        const messageId = await sendFailureAlert(this.env, event, alert);
        state.alertedFailureKeys = [...(state.alertedFailureKeys ?? []).slice(-49), key];
        state.alertMessageIds = [...(state.alertMessageIds ?? []).slice(-49), messageId];
        await this.ctx.storage.put("state", state);
      }
    }
    console.log(JSON.stringify({
      event_id: event.eventId,
      thread_id: event.threadId,
      phase: state.phase,
      last_error: state.lastError?.slice(0, 240),
    }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    assertConfigured();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "agentmail-scheduler-webhook", hosted_execution: true });
    }
    if (request.method !== "POST" || url.pathname !== "/webhooks/agentmail") return new Response("Not found", { status: 404 });
    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) return new Response("Payload too large", { status: 413 });
    if (!(await verifyAgentMailSignature(request, rawBody, env.AGENTMAIL_SIGNING_SECRET))) return new Response("Unauthorized", { status: 401 });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const event = normalizeEvent(payload);
    if (!ACCEPTED_EVENTS.has(event.eventType)) return new Response("Ignored", { status: 200 });
    if (event.inboxId !== schedulerConfig.schedulerInbox) return new Response("Ignored", { status: 200 });
    if (!event.eventId || !event.threadId || !event.messageId) return new Response("Invalid event", { status: 400 });
    await env.SCHEDULER_QUEUE.send(event, { contentType: "json" });
    console.log(JSON.stringify({ event_id: event.eventId, event_type: event.eventType, inbox_id: event.inboxId }));
    return new Response("Accepted", { status: 202 });
  },

  async queue(batch: MessageBatch<QueueEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      try {
        const id = env.SCHEDULER_THREAD.idFromName(event.threadId);
        const stub = env.SCHEDULER_THREAD.get(id) as DurableObjectStub<SchedulerThread>;
        await stub.process(event);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event_id: event.eventId, event_type: event.eventType, error: error instanceof Error ? error.message.slice(0, 240) : "unknown" }));
        if (message.attempts >= MAX_QUEUE_DELIVERIES) {
          try {
            await sendFailureAlert(env, event, { phase: "retry_exhausted", error: "queue_retry_exhausted" });
          } catch (alertError) {
            console.error(JSON.stringify({ event_id: event.eventId, stage: "failure_alert", error: alertError instanceof Error ? alertError.message.slice(0, 240) : "unknown" }));
          }
        }
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueEvent>;
