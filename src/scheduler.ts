import composeReplyPrompt from "../prompts/compose-reply.txt?raw";
import planSchedulingRequestPrompt from "../prompts/plan-scheduling-request.txt?raw";
import { schedulerConfig } from "./scheduler-config";

export type Phase = "idle" | "proposal_reply_started" | "proposed" | "clarification_reply_started" | "clarified" | "create_started" | "booking_created" | "google_enriched" | "booking_reply_started" | "booked" | "quarantined";

export interface ThreadState {
  phase: Phase;
  processedEventIds: string[];
  proposedStarts: string[];
  proposalRounds?: number;
  durationMinutes?: number;
  confirmedStart?: string;
  title?: string;
  purpose?: string;
  sourceMessageId?: string;
  proposalReplyMessageId?: string;
  expectedRecipients: string[];
  deliveredRecipients: string[];
  bookingUid?: string;
  googleEventId?: string;
  confirmationReplyMessageId?: string;
  lastError?: string;
  alertedFailureKeys?: string[];
  alertMessageIds?: string[];
}

export interface QueueEvent {
  eventId: string;
  eventType: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  recipients: string[];
  reason?: string;
}

export interface FailureAlertDetails {
  phase: string;
  error: string;
  bookingUid?: string;
}

export interface Address { email: string; name?: string }
interface AgentMessage { message_id?: string; timestamp?: string; received_timestamp?: string; from?: unknown; to?: unknown; cc?: unknown; subject?: string; text?: string; extracted_text?: string; preview?: string }
interface AgentThread { messages?: AgentMessage[]; last_message_id?: string; subject?: string }

export interface Plan {
  action: "ignore" | "clarify" | "propose" | "book";
  duration_minutes: number | null;
  title: string;
  purpose: string;
  timezone: string;
  search_windows: Array<{ start: string; end: string }>;
  excluded_windows: Array<{ start: string; end: string }>;
  proposed_starts: string[];
  confirmed_start: string | null;
}

export interface BookingInput {
  threadId: string;
  start: string;
  durationMinutes: number;
  title: string;
  purpose: string;
  primaryAttendee: Address;
  guests: string[];
  expectedAttendees: string[];
}

export interface VerifiedBooking { uid: string; title: string; start: string; end: string; duration: number; icsUid: string; meetingUrl: string; googleEventId: string }
export type Checkpoint = (state: ThreadState) => Promise<void>;

export interface ReplyBrief {
  kind: "proposal" | "clarification" | "unavailable" | "confirmation";
  timezone: string;
  durationMinutes?: number;
  scope?: string;
  slots?: string[];
  requestedSlot?: string;
  alternatives?: string[];
  question?: string;
  title?: string;
  purpose?: string;
  meetUrl?: string;
}

export interface RuntimeDeps {
  now(): Date;
  plan(env: Env, thread: AgentThread, state: ThreadState, now: Date): Promise<Plan>;
  composeReply(env: Env, brief: ReplyBrief): Promise<string>;
  freeBusy(env: Env, starts: string[], durationMinutes: number): Promise<Array<{ start: string; end: string }>>;
  replyAll(env: Env, sourceMessageId: string, text: string, expectedRecipients: string[]): Promise<string>;
  createAndVerifyBooking(env: Env, input: BookingInput): Promise<VerifiedBooking>;
  getAndVerifyExistingBooking(env: Env, input: BookingInput, uid: string): Promise<VerifiedBooking>;
  verifyCalCreatedGoogleEvent(env: Env, booking: VerifiedBooking, input: BookingInput): Promise<{ eventId: string; meetUrl: string }>;
  getThread(env: Env, threadId: string): Promise<AgentThread>;
}

const OWNER_NAME = schedulerConfig.ownerName;
const AGENT_NAME = schedulerConfig.agentName;
const SCHEDULER_EMAIL = schedulerConfig.schedulerInbox;
const ALERT_EMAIL = schedulerConfig.alertEmail;
const OWNER_TIMEZONE = schedulerConfig.ownerTimeZone;
const OWNER_TIMEZONE_LABEL = schedulerConfig.ownerTimeZoneLabel;
const CAL_API = "https://api.cal.com/v2";
const AGENTMAIL_API = "https://api.agentmail.to/v0";
const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const EVENT_TYPE_IDS = schedulerConfig.eventTypeIds;
const MINIMUM_LEAD_TIME_MS = schedulerConfig.minimumLeadHours * 60 * 60 * 1000;
const INCOMPLETE_PHASES = new Set<Phase>(["proposal_reply_started", "clarification_reply_started", "create_started", "booking_created", "google_enriched", "booking_reply_started"]);

function renderPrompt(template: string): string {
  return template
    .replaceAll("{{OWNER_NAME}}", OWNER_NAME)
    .replaceAll("{{AGENT_NAME}}", AGENT_NAME)
    .replaceAll("{{OWNER_TIMEZONE}}", OWNER_TIMEZONE)
    .replaceAll("{{OWNER_TIMEZONE_LABEL}}", OWNER_TIMEZONE_LABEL)
    .replaceAll("{{MINIMUM_LEAD_HOURS}}", String(schedulerConfig.minimumLeadHours))
    .replaceAll("{{DEFAULT_DURATION_MINUTES}}", String(schedulerConfig.defaultDurationMinutes))
    .replaceAll("{{MAXIMUM_PROPOSAL_ROUNDS}}", String(schedulerConfig.maximumProposalRounds))
    .replaceAll("{{BUSINESS_START_HOUR}}", String(schedulerConfig.businessStartHour).padStart(2, "0"))
    .replaceAll("{{EARLIEST_EXPLICIT_HOUR}}", String(schedulerConfig.earliestExplicitHour).padStart(2, "0"))
    .replaceAll("{{BUSINESS_END_HOUR}}", String(schedulerConfig.businessEndHour).padStart(2, "0"));
}

export function emptyState(): ThreadState {
  return { phase: "idle", processedEventIds: [], proposedStarts: [], proposalRounds: 0, expectedRecipients: [], deliveredRecipients: [] };
}

function cleanEmail(value: string): string {
  const bracket = value.match(/<([^>]+)>/);
  return (bracket?.[1] ?? value).trim().toLowerCase();
}

export function addresses(value: unknown): Address[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const result: Address[] = [];
  for (const entry of values) {
    if (typeof entry === "string") {
      const email = cleanEmail(entry);
      const display = entry.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1]?.trim();
      if (email.includes("@")) result.push({ email, name: display || undefined });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const email = cleanEmail(String(record.email ?? record.address ?? ""));
    if (!email.includes("@")) continue;
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    result.push({ email, name: name || undefined });
  }
  return result;
}

function isHuman(email: string): boolean {
  const normalized = email.toLowerCase();
  return normalized !== SCHEDULER_EMAIL
    && !/(?:^|[._-])(?:no[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounce|notifications?|automated?|calendar|bot)(?:$|[.@_-])/i.test(normalized);
}

function unique(values: string[]): string[] { return [...new Set(values)].sort() }
function sameSet(left: string[], right: string[]): boolean {
  const a = unique(left); const b = unique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function humanParticipants(message: AgentMessage): Address[] {
  const all = [...addresses(message.from), ...addresses(message.to), ...addresses(message.cc)];
  const seen = new Set<string>();
  return all.filter((person) => {
    if (!isHuman(person.email) || seen.has(person.email)) return false;
    seen.add(person.email); return true;
  });
}

function messageText(message: AgentMessage): string { return String(message.extracted_text ?? message.text ?? message.preview ?? "").trim() }
function latestInbound(thread: AgentThread): AgentMessage | undefined {
  return [...(thread.messages ?? [])].reverse().find((message) => addresses(message.from).some((sender) => isHuman(sender.email)));
}

function establishedThreadTimezone(thread: AgentThread): string | null {
  const zones = [...new Set((thread.messages ?? [])
    .filter((message) => addresses(message.from).some((sender) => isHuman(sender.email)))
    .map((message) => explicitTimezone(messageText(message)))
    .filter((timezone): timezone is string => Boolean(timezone)))];
  return zones.length === 1 ? zones[0] : null;
}

function requiredDuration(text: string): number | null {
  const minutes = text.match(/\b(15|30|45|60)\s*(?:minutes?|mins?)\b/i);
  if (minutes) return Number(minutes[1]);
  if (/\b(?:an?|one)\s+hours?\b|\b60\s*min/i.test(text)) return 60;
  if (/\bhalf\s+(?:an\s+)?hour\b/i.test(text)) return 30;
  return null;
}

function ownerTimeParts(value: Date): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: get("weekday") };
}

function dateKey(value: Date): string {
  const parts = ownerTimeParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
}
function weekdayNumber(key: string): number { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() }
function nextMonday(today: string): string { const day = weekdayNumber(today); return addCalendarDays(today, day === 0 ? 1 : 8 - day) }

export function planningDateContext(now: Date): Record<string, unknown> {
  const today = dateKey(now);
  const nextWeekMonday = nextMonday(today);
  const parts = ownerTimeParts(now);
  return {
    timezone: OWNER_TIMEZONE,
    current_local_date: today,
    current_local_weekday: new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, weekday: "long" }).format(now),
    current_local_time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
    next_week: {
      monday: nextWeekMonday,
      tuesday: addCalendarDays(nextWeekMonday, 1),
      wednesday: addCalendarDays(nextWeekMonday, 2),
      thursday: addCalendarDays(nextWeekMonday, 3),
      friday: addCalendarDays(nextWeekMonday, 4),
    },
    early_next_week: {
      start: nextWeekMonday,
      end: addCalendarDays(nextWeekMonday, 2),
    },
  };
}

const REQUEST_TIMEZONE_ALIASES: Array<{ pattern: RegExp; timeZone: string }> = [
  { pattern: /\b(?:PT|PST|PDT|Pacific(?:\s+(?:Standard|Daylight))?(?:\s+Time)?)\b/i, timeZone: "America/Los_Angeles" },
  { pattern: /\b(?:ET|EST|EDT|Eastern(?:\s+(?:Standard|Daylight))?(?:\s+Time)?)\b/i, timeZone: "America/New_York" },
  { pattern: /\b(?:CT|CST|CDT|Central(?:\s+(?:Standard|Daylight))?(?:\s+Time)?)\b/i, timeZone: "America/Chicago" },
  { pattern: /\b(?:MT|MST|MDT|Mountain(?:\s+(?:Standard|Daylight))?(?:\s+Time)?)\b/i, timeZone: "America/Denver" },
  { pattern: /\b(?:UTC|GMT)\b/i, timeZone: "UTC" },
];

function explicitTimezone(text: string): string | null {
  return REQUEST_TIMEZONE_ALIASES.find((entry) => entry.pattern.test(text))?.timeZone ?? null;
}

function requestedTimezone(text: string): string {
  return explicitTimezone(text) ?? OWNER_TIMEZONE;
}

function zonedParts(value: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")) };
}

function zonedInstant(key: string, hour: number, minute: number, timeZone: string): string | null {
  const [year, month, day] = key.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const matches: number[] = [];
  // Scan plausible offsets so DST transitions are deterministic. A nonexistent
  // wall time has no match; an ambiguous fall-back time has two and is rejected.
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const instant = desired - offsetMinutes * 60_000;
    const parts = zonedParts(new Date(instant), timeZone);
    if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute) matches.push(instant);
  }
  return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
}

function dateKeyInTimezone(value: Date, timeZone: string): string {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function minutesForTime(hourText: string, minuteText: string | undefined, meridiem: string): number {
  let hour = Number(hourText) % 12;
  if (meridiem.toLowerCase() === "pm") hour += 12;
  return hour * 60 + Number(minuteText ?? 0);
}

function explicitEarliestHour(text: string): number | null {
  let earliest: number | null = null;
  for (const match of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    let hour = Number(match[1]) % 12;
    if (match[3].toLowerCase() === "pm") hour += 12;
    if (earliest === null || hour < earliest) earliest = hour;
  }
  return earliest;
}

export function startMatchesRequest(startIso: string, text: string, now: Date, timezoneOverride?: string | null): boolean {
  const start = new Date(startIso);
  if (!Number.isFinite(start.getTime()) || start <= now) return false;
  const parts = ownerTimeParts(start);
  if (!schedulerConfig.allowedWeekdays.includes(parts.weekday as never)) return false;
  // An explicit time in another timezone is converted before this check. Do
  // not compare its wall-clock hour to the owner's local hour.
  const timezone = timezoneOverride ?? requestedTimezone(text);
  const explicit = timezone === OWNER_TIMEZONE ? explicitEarliestHour(text) : null;
  const earliest = explicit !== null && explicit < schedulerConfig.businessStartHour
    ? Math.max(explicit, schedulerConfig.earliestExplicitHour)
    : schedulerConfig.businessStartHour;
  if (parts.hour < earliest || parts.hour >= schedulerConfig.businessEndHour || (explicit !== null && explicit < schedulerConfig.earliestExplicitHour)) return false;
  if (/\bmornings?\b/i.test(text) && parts.hour >= 12) return false;
  if (/\bafternoons?\b/i.test(text) && parts.hour < 12) return false;
  const today = dateKeyInTimezone(now, timezone); const target = dateKeyInTimezone(start, timezone);
  if (/\btomorrow\b/i.test(text) && target !== addCalendarDays(today, 1)) return false;
  if (/\bearly\s+next\s+week\b/i.test(text)) {
    const monday = nextMonday(today);
    if (![monday, addCalendarDays(monday, 1), addCalendarDays(monday, 2)].includes(target)) return false;
  } else if (/\bnext\s+week\b/i.test(text)) {
    const monday = nextMonday(today);
    if (!Array.from({ length: 5 }, (_, index) => addCalendarDays(monday, index)).includes(target)) return false;
  }
  if (/\bnext\s+(?:few|three)\s+days\b/i.test(text)) {
    const allowed = [1, 2, 3, 4, 5].map((offset) => addCalendarDays(today, offset)).filter((key) => ![0, 6].includes(weekdayNumber(key))).slice(0, 3);
    if (!allowed.includes(target)) return false;
  }
  return true;
}

function withinWindows(start: string, duration: number, windows: Plan["search_windows"]): boolean {
  const startMs = Date.parse(start); const endMs = startMs + duration * 60_000;
  return windows.some((window) => startMs >= Date.parse(window.start) && endMs <= Date.parse(window.end));
}

function overlapsWindows(start: string, duration: number, windows: Plan["excluded_windows"]): boolean {
  const startMs = Date.parse(start); const endMs = startMs + duration * 60_000;
  return windows.some((window) => startMs < Date.parse(window.end) && endMs > Date.parse(window.start));
}

function canonicalIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function candidatesFromWindows(windows: Plan["search_windows"], duration: number, text: string, now: Date): string[] {
  const candidates: string[] = [];
  for (const window of windows.slice(0, 10)) {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 8 * 24 * 60 * 60_000) continue;
    let cursor = Math.ceil(start / (30 * 60_000)) * 30 * 60_000;
    while (cursor + duration * 60_000 <= end && candidates.length < 120) {
      const candidate = new Date(cursor).toISOString();
      if (startMatchesRequest(candidate, text, now)) candidates.push(candidate);
      cursor += 30 * 60_000;
    }
  }
  return candidates;
}

export function validCandidateStarts(plan: Plan, text: string, now: Date, duration: number): string[] {
  const windows = plan.search_windows;
  if (windows.length === 0) return [];
  return unique([
    ...plan.proposed_starts.map(canonicalIso).filter((start): start is string => Boolean(start)),
    ...candidatesFromWindows(windows, duration, text, now),
  ])
    .filter((start) => startMatchesRequest(start, text, now))
    .filter((start) => hasMinimumLeadTime(start, now))
    .filter((start) => withinWindows(start, duration, windows))
    .filter((start) => !overlapsWindows(start, duration, plan.excluded_windows));
}

export function hasMinimumLeadTime(startIso: string, now: Date): boolean {
  const start = Date.parse(startIso);
  return Number.isFinite(start) && start >= now.getTime() + MINIMUM_LEAD_TIME_MS;
}

function requestAnchor(message: AgentMessage, fallback: Date): Date {
  const parsed = new Date(String(message.received_timestamp ?? message.timestamp ?? ""));
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > fallback.getTime() + 5 * 60_000) return fallback;
  return parsed;
}
function isBlockedStart(start: string, blockedStarts: Array<{ start: string; end: string }>): boolean {
  const startMs = Date.parse(start);
  return blockedStarts.some((entry) => Date.parse(entry.start) === startMs);
}

function sourcePurpose(thread: AgentThread): string | null {
  const text = (thread.messages ?? [])
    .filter((message) => !addresses(message.from).some((sender) => sender.email === SCHEDULER_EMAIL))
    .map(messageText)
    .join("\n");
  if (/\b(?:introductory|intro)\b[\s\S]{0,160}\b(?:services?|learn|understand)\b|\b(?:learn|understand)[\s\S]{0,120}\bservices?\b/i.test(text)) {
    return `Introductory call to learn more about ${OWNER_NAME}'s services.`;
  }
  if (/\b(?:introductory|intro)\s+(?:meeting|call)\b/i.test(text)) return "Introductory call.";
  return null;
}

function safePurpose(plan: Plan, thread: AgentThread): string {
  const sourced = sourcePurpose(thread);
  if (sourced) return sourced;
  const purpose = plan.purpose.trim();
  if (!purpose || /\b(this response|proposes?|time slots?|availability options?|conversation requested|meeting requested|scheduling)\b/i.test(purpose)) return "Conversation";
  return purpose;
}

function safeTitle(plan: Plan, primary: Address, purpose: string, subject = ""): string {
  const person = primary.name?.trim() || primary.email.split("@")[0];
  const participant = person.toLowerCase() === OWNER_NAME.toLowerCase() ? "" : ` — ${OWNER_NAME} + ${person}`;
  if (/\bintroductory\b/i.test(purpose)) return `Introductory Call${participant}`.slice(0, 80);
  const proposed = plan.title.trim();
  const operational = /^(meeting|call|chat|sync|discussion)$/i.test(proposed)
    || /\b(availability|available times|proposed|time slots?|scheduling|meeting request|times? for (?:monday|tuesday|wednesday|thursday|friday))\b/i.test(proposed);
  if (!operational && proposed.length >= 6) return proposed.slice(0, 80);
  const usefulSubject = subject.replace(/^\s*re:\s*/i, "").trim();
  if (usefulSubject && !/^(meeting|meeting request|scheduling|availability)$/i.test(usefulSubject)) return `${usefulSubject} — ${OWNER_NAME} + ${person}`.slice(0, 80);
  return `${OWNER_NAME} + ${person}`.slice(0, 80);
}

function proposalStarts(starts: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const start of unique(starts)) {
    const key = dateKey(new Date(start));
    groups.set(key, [...(groups.get(key) ?? []), start]);
  }
  const days = [...groups.keys()];
  const selectedDays = days.length <= 3
    ? days
    : Array.from({ length: 3 }, (_, index) => days[Math.round(index * (days.length - 1) / 2)]);
  return selectedDays.flatMap((day, dayIndex) => {
    const dayStarts = groups.get(day) ?? [];
    if (dayStarts.length <= 2) return dayStarts;
    const earlyIndex = Math.min(dayIndex, Math.floor((dayStarts.length - 1) / 3));
    const laterIndex = Math.min(dayStarts.length - 1, Math.ceil(dayStarts.length / 2) + dayIndex);
    return unique([dayStarts[earlyIndex], dayStarts[laterIndex]]);
  });
}

function proposalLines(starts: string[]): string {
  const groups = new Map<string, Date[]>();
  for (const start of starts) {
    const value = new Date(start); const key = dateKey(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, weekday: "long", month: "long", day: "numeric" });
  const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, hour: "numeric", minute: "2-digit" });
  const time = (value: Date) => timeFormat.format(value).replace(" AM", "am").replace(" PM", "pm");
  return [...groups.values()].map((values) => {
    const times = values.map(time);
    return `- ${dayFormat.format(values[0])}: ${times.join(" or ")} ${OWNER_TIMEZONE_LABEL}`;
  }).join("\n");
}

function conversationalSlot(startIso: string): string {
  const start = new Date(startIso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, weekday: "long", month: "long", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(start).replace(" AM", "am").replace(" PM", "pm");
  return `${day} at ${time} ${OWNER_TIMEZONE_LABEL}`;
}

function bookingConfirmationText(input: BookingInput, meetUrl: string): string {
  return `You’re confirmed for a ${input.durationMinutes}-minute meeting with ${OWNER_NAME} on ${conversationalSlot(input.start)}.\n\nGoogle Meet: ${meetUrl}\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\n${AGENT_NAME}`;
}

function proposalText(starts: string[], durationMinutes: number, requestText: string): string {
  const lines = proposalLines(starts);
  const dayCount = new Set(starts.map((start) => dateKey(new Date(start)))).size;
  if (dayCount === 1 && starts.length <= 2) {
    const date = new Date(starts[0]);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, weekday: "long" }).format(date);
    const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, hour: "numeric", minute: "2-digit" });
    const times = starts.map((start) => timeFormat.format(new Date(start)).replace(" AM", "am").replace(" PM", "pm"));
    const options = times.join(times.length === 2 ? " or " : "");
    const question = times.length === 2 ? "Would either time work for you?" : "Would that time work for you?";
    return `${OWNER_NAME} has availability for a ${durationMinutes}-minute meeting on ${day} at ${options} ${OWNER_TIMEZONE_LABEL}. ${question}\n\nThank you,\n\n${AGENT_NAME}`;
  }
  const window = /\bearly\s+next\s+week\b/i.test(requestText) ? " early next week"
    : /\bnext\s+week\b/i.test(requestText) ? " next week"
      : /\btomorrow\b/i.test(requestText) ? " tomorrow"
        : "";
  return `${OWNER_NAME} has availability${window} for a ${durationMinutes}-minute meeting on the following days:\n\n${lines}\n\nCould you please let me know which of these options works best for you?\n\nThank you,\n\n${AGENT_NAME}`;
}
function clarificationText(text: string): string { return requiredDuration(text) ? "What day or time window would work best for the meeting?" : "How much time should I hold for the meeting?" }
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

export function exactRequestedStart(text: string, anchor: Date, timezoneOverride?: string | null): string | null {
  if (/\b(?:from|between)\b[\s\S]{0,24}\b(?:to|and)\b|\d\s*(?:-|–)\s*\d/i.test(text)) return null;
  const times = [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi)];
  if (times.length !== 1) return null;
  const timeZone = timezoneOverride ?? explicitTimezone(text);
  if (!timeZone) return null;
  const meridiem = times[0][3].replace(/\./g, "");
  const requestedMinute = minutesForTime(times[0][1], times[0][2], meridiem);
  const anchorKey = dateKeyInTimezone(anchor, timeZone);
  let requestedDate: string | null = null;

  if (/\btomorrow\b/i.test(text)) requestedDate = addCalendarDays(anchorKey, 1);
  else if (/\btoday\b/i.test(text)) requestedDate = anchorKey;
  else {
    const weekday = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1]?.toLowerCase();
    if (weekday) {
      const target = WEEKDAYS.indexOf(weekday);
      let offset = (target - weekdayNumber(anchorKey) + 7) % 7;
      if (offset === 0) {
        const anchorParts = zonedParts(anchor, timeZone);
        const anchorMinute = anchorParts.hour * 60 + anchorParts.minute;
        if (requestedMinute <= anchorMinute) offset = 7;
      }
      requestedDate = addCalendarDays(anchorKey, offset);
    } else {
      const monthDate = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
      if (monthDate) {
        const month = MONTHS[monthDate[1].toLowerCase()];
        const year = Number(monthDate[3] ?? zonedParts(anchor, timeZone).year);
        requestedDate = `${year}-${String(month).padStart(2, "0")}-${String(Number(monthDate[2])).padStart(2, "0")}`;
      }
    }
  }
  if (!requestedDate) return null;
  const start = zonedInstant(requestedDate, Math.floor(requestedMinute / 60), requestedMinute % 60, timeZone);
  return start && Date.parse(start) > anchor.getTime() ? start : null;
}

function unavailableExactText(requested: string, alternatives: string[]): string {
  const requestedDate = new Date(requested);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, weekday: "long" }).format(requestedDate);
  const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: OWNER_TIMEZONE, hour: "numeric", minute: "2-digit" });
  const formatTime = (value: Date) => timeFormat.format(value).replace(" AM", "am").replace(" PM", "pm");
  if (alternatives.length > 0) {
    const times = alternatives.map((value) => formatTime(new Date(value))).join(alternatives.length === 2 ? " or " : ", ");
    const question = alternatives.length === 1 ? "Would that work?" : "Would either of those work?";
    return `${day} at ${formatTime(requestedDate)} is already booked, but ${times} ${OWNER_TIMEZONE_LABEL} ${alternatives.length === 1 ? "is" : "are"} still open. ${question}\n\n${AGENT_NAME}`;
  }
  return `${day} at ${formatTime(requestedDate)} ${OWNER_TIMEZONE_LABEL} is unavailable. Would you like me to check another time?\n\n${AGENT_NAME}`;
}

function exactTimeQuestion(): string {
  return `Please suggest an exact date and time at least ${schedulerConfig.minimumLeadHours} hours from now, including your timezone.`;
}

function staleProposalQuestion(): string {
  return `That proposed time is now within ${schedulerConfig.minimumLeadHours} hours. Please suggest another exact date and time at least ${schedulerConfig.minimumLeadHours} hours from now, including your timezone.`;
}

function requestScope(text: string): string {
  if (/\bearly\s+next\s+week\b/i.test(text)) return "early next week";
  if (/\bnext\s+week\b/i.test(text)) return "next week";
  if (/\btomorrow\b/i.test(text)) return "tomorrow";
  if (/\bmornings?\b/i.test(text)) return "in the morning";
  if (/\bafternoons?\b/i.test(text)) return "in the afternoon";
  return "";
}

function proposalBrief(starts: string[], duration: number, requestText: string): ReplyBrief {
  return {
    kind: "proposal",
    timezone: OWNER_TIMEZONE_LABEL,
    durationMinutes: duration,
    scope: requestScope(requestText),
    slots: proposalLines(starts).split("\n").map((line) => line.replace(/^-\s*/, "")),
  };
}

function confirmationBrief(input: BookingInput, meetUrl: string): ReplyBrief {
  return {
    kind: "confirmation",
    timezone: OWNER_TIMEZONE_LABEL,
    durationMinutes: input.durationMinutes,
    requestedSlot: conversationalSlot(input.start),
    meetUrl,
  };
}

function factTokens(value: string): string[] {
  return value.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|\d{1,2}:\d{2}(?:am|pm)|\b[A-Z]{2,5}\b)/g) ?? [];
}

function includesFacts(text: string, values: string[]): boolean {
  const normalized = text.toLowerCase();
  return values.flatMap(factTokens).every((token) => normalized.includes(token.toLowerCase()));
}

function containsOnlyFacts(text: string, values: string[]): boolean {
  const allowed = new Set(values.flatMap(factTokens).map((token) => token.toLowerCase()));
  return factTokens(text).every((token) => allowed.has(token.toLowerCase()));
}

function factOccurrenceCount(text: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "gi")) ?? []).length;
}

function includesQuestionTopic(text: string, question: string): boolean {
  const ignored = new Set(["what", "which", "when", "where", "would", "could", "should", "best", "work", "meeting", "please"]);
  const topics = (question.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => !ignored.has(word));
  const normalized = text.toLowerCase();
  return topics.length === 0 || topics.some((word) => normalized.includes(word));
}

function normalizePlainTextLayout(text: string): string {
  const lines = text.trim().replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const normalizedMarker = line.replace(/^\s*[*+•-]\s+/, "- ");
    return normalizedMarker.trimEnd();
  });
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isBullet = /^-\s+\S/.test(line);
    const previousIsBullet = index > 0 && /^-\s+\S/.test(lines[index - 1]);
    const nextIsBullet = index + 1 < lines.length && /^-\s+\S/.test(lines[index + 1]);
    if (isBullet && !previousIsBullet && output.at(-1) !== "") output.push("");
    output.push(line);
    if (isBullet && !nextIsBullet && index + 1 < lines.length && lines[index + 1] !== "") output.push("");
  }
  let normalized = output.join("\n").replace(/\n{3,}/g, "\n\n");
  const signatureSuffix = `\n${AGENT_NAME}`;
  if (normalized.endsWith(signatureSuffix)) {
    normalized = `${normalized.slice(0, -signatureSuffix.length).replace(/\n+$/, "")}\n\n${AGENT_NAME}`;
  }
  return normalized.trim();
}

export function validateComposedReply(text: string, brief: ReplyBrief): string {
  const clean = normalizePlainTextLayout(text);
  if (clean.length < 12 || clean.length > 1600) throw new Error("reply_composer_invalid_length");
  if (/[—]|<\/?[a-z][^>]*>|\b(?:as an ai|certainly|i'?d be happy to|a few times(?:\s+\w+){0,4}\s+could work|pick one|you'?re all set)\b/i.test(clean)) throw new Error("reply_composer_voice_violation");
  if (/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+is available at\b/i.test(clean)) throw new Error("reply_composer_role_violation");
  if (!clean.endsWith(`\n${AGENT_NAME}`) && clean !== AGENT_NAME) throw new Error("reply_composer_missing_signature");
  if (brief.kind !== "clarification" && !clean.includes(brief.timezone)) throw new Error("reply_composer_missing_timezone");
  if (brief.kind === "proposal") {
    if (!brief.slots?.length || !includesFacts(clean, brief.slots) || !containsOnlyFacts(clean, brief.slots)) throw new Error("reply_composer_invalid_slots");
    if (/\b(?:each|every)\s+meeting\b|\bmeetings?\s+will\s+be\b/i.test(clean)) throw new Error("reply_composer_proposal_voice");
    const durationMentions = clean.match(new RegExp(`\\b${brief.durationMinutes}(?:-minute|\\s+minutes?)\\b`, "gi")) ?? [];
    if (durationMentions.length !== 1) throw new Error("reply_composer_proposal_duration");
    if (brief.slots.length === 1 && !clean.toLowerCase().includes(OWNER_NAME.toLowerCase())) throw new Error("reply_composer_missing_host");
    if (brief.slots.length > 1) {
      const listBlocks = clean.split(/\n{2,}/).filter((block) => block.split("\n").every((line) => /^-\s+\S/.test(line)));
      if (listBlocks.length !== 1 || listBlocks[0].split("\n").length !== brief.slots.length) throw new Error("reply_composer_proposal_layout");
    }
  } else if (brief.kind === "clarification") {
    if (!brief.question || (clean.match(/\?/g) ?? []).length !== 1 || !includesFacts(clean, [brief.question]) || !containsOnlyFacts(clean, [brief.question]) || !includesQuestionTopic(clean, brief.question)) throw new Error("reply_composer_invalid_question");
  } else if (brief.kind === "unavailable") {
    const slots = [brief.requestedSlot ?? "", ...(brief.alternatives ?? [])];
    if (!brief.requestedSlot || !includesFacts(clean, slots) || !containsOnlyFacts(clean, slots)) throw new Error("reply_composer_invalid_unavailable_facts");
  } else {
    const required = [brief.requestedSlot ?? ""];
    const blocks = clean.split(/\n{2,}/);
    const meetUrl = brief.meetUrl ?? "";
    const opening = blocks[0] ?? "";
    const meetLine = blocks[1] ?? "";
    const closing = blocks[2] ?? "";
    const expectedFacts = factTokens(brief.requestedSlot ?? "").map((token) => token.toLowerCase());
    const factsAppearOnce = expectedFacts.every((token) => factOccurrenceCount(clean, token) === 1);
    const durationPattern = new RegExp(`\\b${brief.durationMinutes}-minute\\b`, "i");
    const oneOpeningSentence = (opening.match(/[.!?](?:\s|$)/g) ?? []).length === 1;
    const oneClosingSentence = (closing.match(/[.!?](?:\s|$)/g) ?? []).length === 1 && closing.split(/\s+/).length <= 20;
    if (blocks.length !== 4 || blocks[3] !== AGENT_NAME || !oneOpeningSentence || !oneClosingSentence || blocks.some((block) => block.split("\n").some((line) => /^-\s+\S/.test(line)))) {
      throw new Error("reply_composer_confirmation_layout");
    }
    if (!/^(?:You(?:'|’)re|Your)\b/i.test(opening) || !opening.toLowerCase().includes(`meeting with ${OWNER_NAME.toLowerCase()}`) || !/\bconfirmed\b/i.test(opening) || !durationPattern.test(opening)
      || !includesFacts(clean, required) || !containsOnlyFacts(clean, required) || !factsAppearOnce
      || !/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(meetUrl) || meetLine !== `Google Meet: ${meetUrl}`
      || !/Cal\.com/i.test(closing) || !/\binbox\b/i.test(closing) || !/reschedul/i.test(closing) || !/cancel/i.test(closing)) {
      throw new Error("reply_composer_missing_confirmation_facts");
    }
  }
  return clean;
}

export async function composeReply(env: Env, brief: ReplyBrief): Promise<string> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  };
  const result = await env.AI.run(schedulerConfig.workersAiModel, {
    messages: [{ role: "user", content: `${renderPrompt(composeReplyPrompt)}\n\nVerified scheduling facts:\n${JSON.stringify(brief)}` }],
    response_format: { type: "json_schema", json_schema: { name: "scheduler_reply", strict: true, schema } },
    max_tokens: 500,
    temperature: 0.55,
  } as never) as unknown;
  const raw = result && typeof result === "object" && "response" in result ? (result as Record<string, unknown>).response : result;
  const parsed = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
  return validateComposedReply(String(parsed?.text ?? ""), brief);
}

async function composedOrFallback(env: Env, deps: RuntimeDeps, brief: ReplyBrief, fallback: string): Promise<string> {
  try { return validateComposedReply(await deps.composeReply(env, brief), brief); }
  catch { return fallback; }
}

function deterministicConfirmation(input: BookingInput, meetUrl: string): string {
  const brief = confirmationBrief(input, meetUrl);
  return validateComposedReply(bookingConfirmationText(input, meetUrl), brief);
}

function choosePrimary(message: AgentMessage, hostEmail: string): { primary: Address; guests: string[]; expected: string[] } | null {
  // The latest inbound message is the authority for the current attendee set.
  // Do not carry people forward from quoted or earlier thread messages.
  const participants = humanParticipants(message); const expected = unique(participants.map((person) => person.email));
  const external = participants.filter((person) => person.email !== hostEmail.toLowerCase());
  const sender = addresses(message.from).find((person) => person.email !== hostEmail.toLowerCase() && isHuman(person.email));
  const primary = sender ?? external[0];
  if (!primary) return null;
  return { primary, guests: unique(external.filter((person) => person.email !== primary.email).map((person) => person.email)), expected };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400) }

class RetryablePreMutationReadError extends Error {
  constructor(stage: string, cause: unknown) {
    super(`cal_availability_retryable:${stage}: ${errorMessage(cause)}`);
    this.name = "RetryablePreMutationReadError";
  }
}

async function readAvailability(env: Env, deps: RuntimeDeps, starts: string[], duration: number): Promise<Array<{ start: string; end: string }>> {
  try { return await deps.freeBusy(env, starts, duration); }
  catch (error) { throw new RetryablePreMutationReadError("freebusy", error); }
}

function canRecoverPreMutationQuarantine(state: ThreadState): boolean {
  const preMutationError = Boolean(state.lastError?.startsWith("freebusy_failed_closed:"))
    || state.lastError === "planner_returned_no_valid_candidates"
    || state.lastError === "no_available_valid_candidates";
  return state.phase === "quarantined"
    && preMutationError
    && !state.sourceMessageId
    && !state.proposalReplyMessageId
    && !state.bookingUid
    && !state.googleEventId
    && !state.confirmationReplyMessageId;
}

function canRecoverAlternativeExactTimeQuarantine(state: ThreadState): boolean {
  return state.phase === "quarantined"
    && state.lastError === "confirmation_does_not_match_exact_proposal"
    && state.proposedStarts.length > 0
    && Boolean(state.durationMinutes && state.title && state.purpose)
    && !state.bookingUid
    && !state.googleEventId
    && !state.confirmationReplyMessageId;
}

function canResumePostCreateVerification(state: ThreadState): boolean {
  return state.phase === "quarantined"
    && Boolean(state.lastError?.startsWith("cal_created_google_verification_failed:"))
    && Boolean(state.bookingUid)
    && !state.confirmationReplyMessageId
    && Boolean(state.durationMinutes && state.title && state.purpose && state.sourceMessageId);
}

export async function processQueueEvent(env: Env, state: ThreadState, event: QueueEvent, checkpoint: Checkpoint, deps: RuntimeDeps = productionDeps): Promise<ThreadState> {
  if (state.processedEventIds.includes(event.eventId)) return state;
  const markProcessed = () => {
    if (!state.processedEventIds.includes(event.eventId)) state.processedEventIds = [...state.processedEventIds.slice(-199), event.eventId];
  };
  if (event.eventType !== "message.received") {
    markProcessed();
    const recipients = unique(event.recipients.filter(isHuman));
    if (event.eventType === "message.delivered") state.deliveredRecipients = unique([...state.deliveredRecipients, ...recipients]);
    if (["message.bounced", "message.rejected", "message.complained"].includes(event.eventType)) state.lastError = `${event.eventType}${event.reason ? `: ${event.reason.slice(0, 240)}` : ""}`;
    await checkpoint(state); return state;
  }
  if (canRecoverPreMutationQuarantine(state)) {
    state.phase = "idle";
    state.lastError = undefined;
    await checkpoint(state);
  } else if (canRecoverAlternativeExactTimeQuarantine(state)) {
    state.phase = "proposed";
    state.lastError = undefined;
    await checkpoint(state);
  }
  const resumablePostCreateVerification = canResumePostCreateVerification(state);
  if (["create_started", "booking_created", "google_enriched", "booking_reply_started", "booked"].includes(state.phase)
    || (state.phase === "quarantined" && !resumablePostCreateVerification)) return state;

  const thread = await deps.getThread(env, event.threadId); const latest = latestInbound(thread);
  if (!latest) {
    markProcessed(); state.phase = "quarantined"; state.lastError = "message_received_without_inbound_message"; await checkpoint(state); return state;
  }
  const sourceMessageId = String(latest.message_id ?? event.messageId);
  if (!sourceMessageId || sourceMessageId !== String(thread.last_message_id ?? sourceMessageId)) return state;
  const text = messageText(latest); const participants = choosePrimary(latest, schedulerConfig.primaryCalendarId);
  if (!participants || participants.expected.length === 0) {
    markProcessed(); state.phase = "quarantined"; state.lastError = "no_human_participants"; await checkpoint(state); return state;
  }
  const currentNow = deps.now(); const relativeDateAnchor = requestAnchor(latest, currentNow);
  const plan = await deps.plan(env, thread, state, relativeDateAnchor);
  if (plan.action === "ignore") { markProcessed(); await checkpoint(state); return state; }

  const activeProposalTimezone = state.phase === "proposed" && state.proposedStarts.length > 0 ? OWNER_TIMEZONE : null;
  const directTimezone = explicitTimezone(text) ?? establishedThreadTimezone(thread) ?? activeProposalTimezone;
  const directRequestedStart = ["book", "propose"].includes(plan.action)
    ? exactRequestedStart(text, relativeDateAnchor, directTimezone)
    : null;
  if (directRequestedStart && startMatchesRequest(directRequestedStart, text, relativeDateAnchor, directTimezone)) {
    if (!hasMinimumLeadTime(directRequestedStart, currentNow)) {
      const question = exactTimeQuestion();
      markProcessed(); state.phase = "clarification_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
      try {
        const reply = await composedOrFallback(env, deps, { kind: "clarification", timezone: OWNER_TIMEZONE_LABEL, question }, `${question}\n\n${AGENT_NAME}`);
        await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "clarified";
      } catch (error) { state.phase = "quarantined"; state.lastError = `clarification_reply_uncertain: ${errorMessage(error)}`; }
      await checkpoint(state); return state;
    }
    const requestedDuration = requiredDuration(text);
    const duration = state.durationMinutes ?? requestedDuration ?? plan.duration_minutes ?? schedulerConfig.defaultDurationMinutes;
    if (!EVENT_TYPE_IDS[duration] || (requestedDuration && requestedDuration !== duration)) {
      markProcessed(); state.phase = "quarantined"; state.lastError = "invalid_or_mismatched_duration"; await checkpoint(state); return state;
    }
    const blockedStarts = await readAvailability(env, deps, [directRequestedStart], duration);
    if (isBlockedStart(directRequestedStart, blockedStarts)) {
      if ((state.proposalRounds ?? 0) >= schedulerConfig.maximumProposalRounds) {
        const question = `That time is unavailable. Please suggest another exact date and time at least ${schedulerConfig.minimumLeadHours} hours from now, including your timezone.`;
        markProcessed(); state.phase = "clarification_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
        try {
          const reply = await composedOrFallback(env, deps, { kind: "clarification", timezone: OWNER_TIMEZONE_LABEL, question }, `${question}\n\n${AGENT_NAME}`);
          await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "clarified";
        } catch (error) { state.phase = "quarantined"; state.lastError = `clarification_reply_uncertain: ${errorMessage(error)}`; }
        await checkpoint(state); return state;
      }
      const alternatives = state.proposedStarts
        .filter((start) => Date.parse(start) > currentNow.getTime() && dateKey(new Date(start)) === dateKey(new Date(directRequestedStart)))
        .filter((start) => Date.parse(start) !== Date.parse(directRequestedStart))
        .slice(0, 2);
      const blockedAlternatives = alternatives.length > 0 ? await readAvailability(env, deps, alternatives, duration) : [];
      const availableAlternatives = alternatives.filter((start) => !isBlockedStart(start, blockedAlternatives));
      markProcessed(); state.phase = "proposal_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; if (availableAlternatives.length > 0) state.proposalRounds = (state.proposalRounds ?? 0) + 1; await checkpoint(state);
      try {
        const brief: ReplyBrief = { kind: "unavailable", timezone: OWNER_TIMEZONE_LABEL, durationMinutes: duration, requestedSlot: conversationalSlot(directRequestedStart), alternatives: availableAlternatives.map(conversationalSlot) };
        const reply = await composedOrFallback(env, deps, brief, unavailableExactText(directRequestedStart, availableAlternatives));
        state.proposalReplyMessageId = await deps.replyAll(env, sourceMessageId, reply, participants.expected);
        state.phase = "proposed";
        state.proposedStarts = availableAlternatives;
      } catch (error) { state.phase = "quarantined"; state.lastError = `proposal_reply_uncertain: ${errorMessage(error)}`; }
      await checkpoint(state); return state;
    }

    const purpose = state.purpose ?? safePurpose(plan, thread).slice(0, 500);
    const title = state.title ?? safeTitle(plan, participants.primary, purpose, thread.subject);
    const input: BookingInput = { threadId: event.threadId, start: directRequestedStart, durationMinutes: duration, title, purpose, primaryAttendee: participants.primary, guests: participants.guests, expectedAttendees: unique([participants.primary.email, ...participants.guests]) };
    markProcessed(); state.durationMinutes = duration; state.confirmedStart = input.start; state.title = title; state.purpose = purpose; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected;
    let booking: VerifiedBooking;
    if (resumablePostCreateVerification && state.bookingUid) {
      state.phase = "booking_created"; state.lastError = undefined; await checkpoint(state);
      try { booking = await deps.getAndVerifyExistingBooking(env, input, state.bookingUid); }
      catch (error) { state.phase = "quarantined"; state.lastError = `existing_cal_booking_verification_failed: ${errorMessage(error)}`; await checkpoint(state); return state; }
    } else {
      state.phase = "create_started"; await checkpoint(state);
      try { booking = await deps.createAndVerifyBooking(env, input); state.bookingUid = booking.uid; state.phase = "booking_created"; await checkpoint(state); }
      catch (error) { state.phase = "quarantined"; state.lastError = `cal_create_or_verify_uncertain: ${errorMessage(error)}`; await checkpoint(state); return state; }
    }
    let google: { eventId: string; meetUrl: string };
    try { google = await deps.verifyCalCreatedGoogleEvent(env, booking, input); state.googleEventId = google.eventId; state.phase = "google_enriched"; await checkpoint(state); }
    catch (error) { state.phase = "quarantined"; state.lastError = `cal_created_google_verification_failed: ${errorMessage(error)}`; await checkpoint(state); return state; }
    state.phase = "booking_reply_started"; await checkpoint(state);
    const confirmation = await composedOrFallback(env, deps, confirmationBrief(input, google.meetUrl), deterministicConfirmation(input, google.meetUrl));
    try { state.confirmationReplyMessageId = await deps.replyAll(env, sourceMessageId, confirmation, participants.expected); state.phase = "booked"; }
    catch (error) { state.phase = "quarantined"; state.lastError = `booking_reply_uncertain: ${errorMessage(error)}`; }
    await checkpoint(state); return state;
  }

  if (plan.action === "clarify") {
    markProcessed(); state.phase = "clarification_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
    try {
      const question = clarificationText(text);
      const reply = await composedOrFallback(env, deps, { kind: "clarification", timezone: OWNER_TIMEZONE_LABEL, question }, `${question}\n\n${AGENT_NAME}`);
      await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "clarified";
    }
    catch (error) { state.phase = "quarantined"; state.lastError = `clarification_reply_uncertain: ${errorMessage(error)}`; }
    await checkpoint(state); return state;
  }

  if (plan.action === "propose") {
    if (!["idle", "clarified", "proposed"].includes(state.phase)) {
      markProcessed(); state.phase = "quarantined"; state.lastError = "propose_action_in_unsafe_state"; await checkpoint(state); return state;
    }
    if ((state.proposalRounds ?? 0) >= schedulerConfig.maximumProposalRounds) {
      const question = exactTimeQuestion();
      markProcessed(); state.phase = "clarification_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
      try {
        const reply = await composedOrFallback(env, deps, { kind: "clarification", timezone: OWNER_TIMEZONE_LABEL, question }, `${question}\n\n${AGENT_NAME}`);
        await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "clarified";
      } catch (error) { state.phase = "quarantined"; state.lastError = `clarification_reply_uncertain: ${errorMessage(error)}`; }
      await checkpoint(state); return state;
    }
    const requestedDuration = requiredDuration(text); const duration = plan.duration_minutes;
    if (!duration || !EVENT_TYPE_IDS[duration] || (requestedDuration && requestedDuration !== duration)) {
      markProcessed(); state.phase = "quarantined"; state.lastError = "invalid_or_mismatched_duration"; await checkpoint(state); return state;
    }
    const candidates = validCandidateStarts(plan, text, currentNow, duration);
    console.log(JSON.stringify({
      event_id: event.eventId,
      thread_id: event.threadId,
      stage: "availability_candidates",
      duration_minutes: duration,
      search_windows: plan.search_windows.slice(0, 12),
      excluded_windows: plan.excluded_windows.slice(0, 12),
      candidate_starts: candidates.slice(0, 120),
    }));
    if (candidates.length === 0) { markProcessed(); state.phase = "quarantined"; state.lastError = "planner_returned_no_valid_candidates"; await checkpoint(state); return state; }
    const blockedStarts = await readAvailability(env, deps, candidates, duration);
    const available = proposalStarts(candidates.filter((start) => !isBlockedStart(start, blockedStarts)));
    if (available.length === 0) { markProcessed(); state.phase = "quarantined"; state.lastError = "no_available_valid_candidates"; await checkpoint(state); return state; }
    const purpose = state.purpose ?? safePurpose(plan, thread).slice(0, 500);
    const title = state.title ?? safeTitle(plan, participants.primary, purpose, thread.subject);
    markProcessed(); state.phase = "proposal_reply_started"; state.proposedStarts = available; state.proposalRounds = (state.proposalRounds ?? 0) + 1; state.durationMinutes = duration; state.title = title; state.purpose = purpose; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
    try {
      const reply = await composedOrFallback(env, deps, proposalBrief(available, duration, text), proposalText(available, duration, text));
      state.proposalReplyMessageId = await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "proposed";
    }
    catch (error) { state.phase = "quarantined"; state.lastError = `proposal_reply_uncertain: ${errorMessage(error)}`; }
    await checkpoint(state); return state;
  }

  if (plan.action === "book") {
    if (state.phase !== "proposed" && !resumablePostCreateVerification) {
      markProcessed(); state.phase = "quarantined"; state.lastError = "book_action_without_proposed_state"; await checkpoint(state); return state;
    }
    const confirmed = plan.confirmed_start;
    const exactProposedStart = confirmed ? state.proposedStarts.find((start) => Date.parse(start) === Date.parse(confirmed)) : undefined;
    if (!exactProposedStart || !state.durationMinutes || !state.title || !state.purpose) {
      markProcessed(); state.phase = "quarantined"; state.lastError = "confirmation_does_not_match_exact_proposal"; await checkpoint(state); return state;
    }
    if (!hasMinimumLeadTime(exactProposedStart, currentNow)) {
      const question = staleProposalQuestion();
      markProcessed(); state.phase = "clarification_reply_started"; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected; await checkpoint(state);
      try {
        const reply = await composedOrFallback(env, deps, { kind: "clarification", timezone: OWNER_TIMEZONE_LABEL, question }, `${question}\n\n${AGENT_NAME}`);
        await deps.replyAll(env, sourceMessageId, reply, participants.expected); state.phase = "clarified";
      } catch (error) { state.phase = "quarantined"; state.lastError = `clarification_reply_uncertain: ${errorMessage(error)}`; }
      await checkpoint(state); return state;
    }
    const input: BookingInput = { threadId: event.threadId, start: exactProposedStart, durationMinutes: state.durationMinutes, title: state.title, purpose: state.purpose, primaryAttendee: participants.primary, guests: participants.guests, expectedAttendees: unique([participants.primary.email, ...participants.guests]) };
    markProcessed(); state.confirmedStart = exactProposedStart; state.sourceMessageId = sourceMessageId; state.expectedRecipients = participants.expected;
    let booking: VerifiedBooking;
    if (resumablePostCreateVerification && state.bookingUid) {
      state.phase = "booking_created"; state.lastError = undefined; await checkpoint(state);
      try { booking = await deps.getAndVerifyExistingBooking(env, input, state.bookingUid); }
      catch (error) { state.phase = "quarantined"; state.lastError = `existing_cal_booking_verification_failed: ${errorMessage(error)}`; await checkpoint(state); return state; }
    } else {
      state.phase = "create_started"; await checkpoint(state);
      try { booking = await deps.createAndVerifyBooking(env, input); state.bookingUid = booking.uid; state.phase = "booking_created"; await checkpoint(state); }
      catch (error) { state.phase = "quarantined"; state.lastError = `cal_create_or_verify_uncertain: ${errorMessage(error)}`; await checkpoint(state); return state; }
    }
    let google: { eventId: string; meetUrl: string };
    try { google = await deps.verifyCalCreatedGoogleEvent(env, booking, input); state.googleEventId = google.eventId; state.phase = "google_enriched"; await checkpoint(state); }
    catch (error) { state.phase = "quarantined"; state.lastError = `cal_created_google_verification_failed: ${errorMessage(error)}`; await checkpoint(state); return state; }
    state.phase = "booking_reply_started"; await checkpoint(state);
    const confirmation = await composedOrFallback(env, deps, confirmationBrief(input, google.meetUrl), deterministicConfirmation(input, google.meetUrl));
    try { state.confirmationReplyMessageId = await deps.replyAll(env, sourceMessageId, confirmation, participants.expected); state.phase = "booked"; }
    catch (error) { state.phase = "quarantined"; state.lastError = `booking_reply_uncertain: ${errorMessage(error)}`; }
    await checkpoint(state);
  }
  return state;
}

async function boundedFetch(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> { return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) }
async function jsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text(); if (text.length > 1_000_000) throw new Error(`${label}_response_too_large`);
  let parsed: Record<string, unknown>; try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`${label}_invalid_json_${response.status}`); }
  if (!response.ok) throw new Error(`${label}_http_${response.status}`); return parsed;
}
async function agentRequest(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await boundedFetch(`${AGENTMAIL_API}${path}`, { ...init, headers: { Authorization: `Bearer ${env.AGENTMAIL_API_KEY_SCHEDULER}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return jsonResponse(response, "agentmail");
}
export async function getThread(env: Env, threadId: string): Promise<AgentThread> {
  return agentRequest(env, `/inboxes/${encodeURIComponent(SCHEDULER_EMAIL)}/threads/${encodeURIComponent(threadId)}`) as Promise<AgentThread>;
}
async function readSentMessageWithBackoff(env: Env, messageId: string): Promise<Record<string, unknown>> {
  let last: unknown;
  for (const delay of [0, 250, 750, 1500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try { return await agentRequest(env, `/inboxes/${encodeURIComponent(SCHEDULER_EMAIL)}/messages/${encodeURIComponent(messageId)}`); } catch (error) { last = error; }
  }
  throw last ?? new Error("sent_message_readback_failed");
}
export async function replyAll(env: Env, sourceMessageId: string, text: string, expectedRecipients: string[]): Promise<string> {
  const result = await agentRequest(env, `/inboxes/${encodeURIComponent(SCHEDULER_EMAIL)}/messages/${encodeURIComponent(sourceMessageId)}/reply-all`, { method: "POST", body: JSON.stringify({ text }) });
  const messageId = String(result.message_id ?? ""); if (!messageId) throw new Error("reply_all_missing_message_id");
  const sent = await readSentMessageWithBackoff(env, messageId);
  const actual = unique([...addresses(sent.to).map((person) => person.email), ...addresses(sent.cc).map((person) => person.email)].filter(isHuman));
  if (!sameSet(actual, expectedRecipients)) throw new Error("reply_all_recipient_mismatch");
  return messageId;
}

function failureCode(value: string): string {
  return value.split(":", 1)[0].trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 120) || "unknown_scheduler_failure";
}

export function failureAlertDetails(state: ThreadState, event: QueueEvent): FailureAlertDetails | null {
  const deliveryFailure = ["message.bounced", "message.rejected", "message.complained"].includes(event.eventType)
    && state.expectedRecipients.length > 0;
  if (deliveryFailure) {
    return { phase: "attendee_delivery_failed", error: failureCode(state.lastError ?? event.eventType), bookingUid: state.bookingUid };
  }
  if (state.phase === "quarantined" && state.lastError) {
    return { phase: state.phase, error: failureCode(state.lastError), bookingUid: state.bookingUid };
  }
  if (INCOMPLETE_PHASES.has(state.phase)) {
    return { phase: "incomplete_transaction", error: `stalled_${state.phase}`, bookingUid: state.bookingUid };
  }
  return null;
}

export function failureAlertKey(details: FailureAlertDetails): string {
  return `${details.phase}:${details.error}:${details.bookingUid ?? "none"}`.slice(0, 300);
}

export async function sendFailureAlert(env: Env, event: QueueEvent, details: FailureAlertDetails): Promise<string> {
  const bookingStatus = details.bookingUid
    ? `A Cal.com booking may already exist with UID ${details.bookingUid}. Do not create another booking until the thread is reviewed.`
    : "No Cal.com booking is recorded for this failure.";
  const text = `${AGENT_NAME} could not complete a scheduling request and stopped the workflow.\n\nThread: ${event.threadId}\nStatus: ${details.phase}\nFailure: ${details.error}\n\n${bookingStatus}\n\nPlease review the thread before retrying.\n\n${AGENT_NAME}`;
  const result = await agentRequest(env, `/inboxes/${encodeURIComponent(SCHEDULER_EMAIL)}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ to: [ALERT_EMAIL], subject: `${AGENT_NAME} scheduler needs attention`, text }),
  });
  const messageId = String(result.message_id ?? "");
  if (!messageId) throw new Error("failure_alert_missing_message_id");
  const sent = await readSentMessageWithBackoff(env, messageId);
  const actual = unique([...addresses(sent.to).map((person) => person.email), ...addresses(sent.cc).map((person) => person.email)].filter(isHuman));
  if (!sameSet(actual, [ALERT_EMAIL])) throw new Error("failure_alert_recipient_mismatch");
  return messageId;
}

async function googleAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" });
  const response = await boundedFetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const result = await jsonResponse(response, "google_oauth"); const token = String(result.access_token ?? "");
  if (!token) throw new Error("google_oauth_missing_access_token"); return token;
}

export async function freeBusy(env: Env, starts: string[], durationMinutes: number): Promise<Array<{ start: string; end: string }>> {
  const eventTypeId = EVENT_TYPE_IDS[durationMinutes];
  if (!eventTypeId || starts.length === 0) throw new Error("cal_slots_invalid_request");
  const sorted = [...starts].sort((left, right) => Date.parse(left) - Date.parse(right));
  const startDate = dateKey(new Date(sorted[0]));
  const endDate = addCalendarDays(dateKey(new Date(sorted[sorted.length - 1])), 1);
  const query = new URLSearchParams({
    start: startDate,
    end: endDate,
    eventTypeId: String(eventTypeId),
    timeZone: OWNER_TIMEZONE,
    duration: String(durationMinutes),
    format: "range",
  });
  const response = await boundedFetch(`${CAL_API}/slots?${query}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.CAL_COM_TOKEN}`,
      "cal-api-version": schedulerConfig.calSlotsApiVersion,
      "Content-Type": "application/json",
    },
  });
  const result = await jsonResponse(response, "cal_slots");
  if (String(result.status ?? "") !== "success" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error("cal_slots_invalid_response");
  }
  const availableStarts = new Set<number>();
  for (const slots of Object.values(result.data as Record<string, unknown>)) {
    if (!Array.isArray(slots)) throw new Error("cal_slots_invalid_day");
    for (const slot of slots) {
      if (!slot || typeof slot !== "object") throw new Error("cal_slots_invalid_slot");
      const record = slot as Record<string, unknown>;
      const start = Date.parse(String(record.start ?? ""));
      const end = Date.parse(String(record.end ?? ""));
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("cal_slots_invalid_slot");
      if ((end - start) / 60_000 === durationMinutes) availableStarts.add(start);
    }
  }
  const matchedStarts = starts.filter((start) => availableStarts.has(Date.parse(start)));
  console.log(JSON.stringify({
    stage: "cal_slots_summary",
    start_date: startDate,
    end_date: endDate,
    duration_minutes: durationMinutes,
    requested_count: starts.length,
    provider_available_count: availableStarts.size,
    matched_count: matchedStarts.length,
    provider_available_sample: [...availableStarts].sort((left, right) => left - right).slice(0, 12).map((value) => new Date(value).toISOString()),
    matched_sample: matchedStarts.slice(0, 12),
  }));
  return starts
    .filter((start) => !matchedStarts.includes(start))
    .map((start) => ({ start, end: new Date(Date.parse(start) + durationMinutes * 60_000).toISOString() }));
}

function threadForPlanner(thread: AgentThread): string {
  return (thread.messages ?? []).slice(-20).map((message) => `[${message.timestamp ?? message.received_timestamp ?? ""}] ${addresses(message.from)[0]?.email ?? "unknown"}: ${messageText(message).slice(0, 2000)}`).join("\n\n").slice(-20_000);
}

export async function plan(env: Env, thread: AgentThread, state: ThreadState, now: Date): Promise<Plan> {
  const timeWindowsSchema = { type: "array", items: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "string" }, end: { type: "string" } } } };
  const schema = { type: "object", additionalProperties: false, required: ["action", "duration_minutes", "title", "purpose", "timezone", "search_windows", "excluded_windows", "proposed_starts", "confirmed_start"], properties: {
    action: { type: "string", enum: ["ignore", "clarify", "propose", "book"] }, duration_minutes: { anyOf: [{ type: "integer", enum: [15, 30, 45, 60] }, { type: "null" }] }, title: { type: "string" }, purpose: { type: "string" }, timezone: { type: "string" },
    search_windows: timeWindowsSchema,
    excluded_windows: timeWindowsSchema,
    proposed_starts: { type: "array", items: { type: "string" } }, confirmed_start: { anyOf: [{ type: "string" }, { type: "null" }] },
  } };
  const prompt = `${renderPrompt(planSchedulingRequestPrompt)}\n\nDeterministic owner calendar context:\n${JSON.stringify(planningDateContext(now))}\n\nRequest anchor instant: ${now.toISOString()}.\n\nDurable state: ${JSON.stringify({ phase: state.phase, proposedStarts: state.proposedStarts, proposalRounds: state.proposalRounds ?? 0, duration: state.durationMinutes })}\n\nEmail data:\n${threadForPlanner(thread)}`;
  const result = await env.AI.run(schedulerConfig.workersAiModel, { messages: [{ role: "user", content: prompt }], response_format: { type: "json_schema", json_schema: { name: "scheduler_plan", strict: true, schema } }, max_tokens: 1400, temperature: 0 } as never) as unknown;
  const raw = result && typeof result === "object" && "response" in result ? (result as Record<string, unknown>).response : result;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object") throw new Error("planner_invalid_output"); return parsed as Plan;
}

async function calRequest(env: Env, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await boundedFetch(`${CAL_API}${path}`, { ...init, headers: { Authorization: `Bearer ${env.CAL_COM_TOKEN}`, "cal-api-version": schedulerConfig.calBookingsApiVersion, "Content-Type": "application/json", ...(init.headers ?? {}) } }, 30_000);
  return jsonResponse(response, "cal");
}
function dataRecord(value: Record<string, unknown>): Record<string, unknown> {
  const data = value.data; if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("provider_missing_object_data"); return data as Record<string, unknown>;
}
function bookingEmails(booking: Record<string, unknown>): string[] {
  const attendees = Array.isArray(booking.attendees) ? booking.attendees : []; const guests = Array.isArray(booking.guests) ? booking.guests : [];
  return unique([...attendees.flatMap((value) => addresses(value).map((person) => person.email)), ...guests.flatMap((value) => addresses(value).map((person) => person.email))].filter(isHuman));
}
function meetUrlFrom(value: Record<string, unknown>): string {
  for (const candidate of [value.location, value.meetingUrl]) {
    if (typeof candidate === "string" && /https:\/\/meet\.google\.com\//i.test(candidate)) return candidate;
    if (candidate && typeof candidate === "object") { const url = String((candidate as Record<string, unknown>).link ?? (candidate as Record<string, unknown>).url ?? ""); if (/https:\/\/meet\.google\.com\//i.test(url)) return url; }
  }
  return "";
}

export async function createAndVerifyBooking(env: Env, input: BookingInput): Promise<VerifiedBooking> {
  const eventTypeId = EVENT_TYPE_IDS[input.durationMinutes]; if (!eventTypeId) throw new Error("unsupported_duration");
  const notes = `Topic: ${input.title}\nPurpose: ${input.purpose}\nParticipants: ${input.expectedAttendees.join(", ")}\nDuration: ${input.durationMinutes} minutes\n\nScheduled through Cal.com.`;
  const created = await calRequest(env, "/bookings", { method: "POST", body: JSON.stringify({ start: new Date(input.start).toISOString(), eventTypeId, attendee: { name: input.primaryAttendee.name || input.primaryAttendee.email.split("@")[0], email: input.primaryAttendee.email, timeZone: OWNER_TIMEZONE, language: "en" }, guests: input.guests, bookingFieldsResponses: { title: input.title, notes }, metadata: { agentmail_thread_id: input.threadId.slice(0, 500), purpose: input.purpose.slice(0, 500), requested_title: input.title.slice(0, 160) } }) });
  const uid = String(dataRecord(created).uid ?? ""); if (!uid) throw new Error("cal_create_missing_uid");
  return getAndVerifyExistingBooking(env, input, uid);
}

export async function getAndVerifyExistingBooking(env: Env, input: BookingInput, uid: string): Promise<VerifiedBooking> {
  let booking: Record<string, unknown> | undefined; let references: Record<string, unknown>[] = [];
  for (const delay of [250, 750, 1500, 3000]) {
    await new Promise((resolve) => setTimeout(resolve, delay)); booking = dataRecord(await calRequest(env, `/bookings/${encodeURIComponent(uid)}`));
    const refsResult = await calRequest(env, `/bookings/${encodeURIComponent(uid)}/references?type=google_calendar`);
    references = Array.isArray(refsResult.data) ? refsResult.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
    if (references.length === 1 && String(references[0].eventUid ?? "")) break;
  }
  if (!booking) throw new Error("cal_booking_readback_missing");
  if (String(booking.uid ?? "") !== uid || String(booking.status ?? "") !== "accepted") throw new Error("cal_booking_status_mismatch");
  const start = String(booking.start ?? ""); const end = String(booking.end ?? ""); const duration = Number(booking.duration ?? (Date.parse(end) - Date.parse(start)) / 60_000); const metadata = booking.metadata as Record<string, unknown> | undefined;
  const fields = booking.bookingFieldsResponses as Record<string, unknown> | undefined;
  if (Date.parse(start) !== Date.parse(input.start) || duration !== input.durationMinutes) throw new Error("cal_booking_time_mismatch");
  const providerTitle = String(booking.title ?? "").trim();
  if (!providerTitle || String(fields?.title ?? "") !== input.title || !String(fields?.notes ?? booking.description ?? "").includes(input.purpose)) throw new Error("cal_booking_content_mismatch");
  if (String(metadata?.agentmail_thread_id ?? "") !== input.threadId || String(metadata?.purpose ?? "") !== input.purpose.slice(0, 500)) throw new Error("cal_booking_metadata_mismatch");
  if (!sameSet(bookingEmails(booking), input.expectedAttendees)) throw new Error("cal_booking_attendee_mismatch");
  if (references.length !== 1 || String(references[0].type ?? "") !== "google_calendar") throw new Error("cal_google_reference_mismatch");
  if (String(references[0].destinationCalendarId ?? "") !== schedulerConfig.primaryCalendarId) throw new Error("cal_destination_calendar_mismatch");
  const googleEventId = String(references[0].eventUid ?? ""); const icsUid = String(booking.icsUid ?? "");
  if (!googleEventId || !icsUid) throw new Error("cal_reference_identity_missing");
  return { uid, title: providerTitle, start, end, duration, icsUid, meetingUrl: meetUrlFrom(booking), googleEventId };
}

function googleMeetUrl(event: Record<string, unknown>): string {
  const hangout = String(event.hangoutLink ?? ""); if (/https:\/\/meet\.google\.com\//i.test(hangout)) return hangout;
  const conference = event.conferenceData as Record<string, unknown> | undefined; const entryPoints = Array.isArray(conference?.entryPoints) ? conference.entryPoints : [];
  for (const point of entryPoints) { if (!point || typeof point !== "object") continue; const uri = String((point as Record<string, unknown>).uri ?? ""); if (/https:\/\/meet\.google\.com\//i.test(uri)) return uri; }
  return "";
}
async function googleEventRequest(env: Env, token: string, eventId: string, init: RequestInit = {}, query = ""): Promise<Record<string, unknown>> {
  const url = `${GOOGLE_API}/calendars/${encodeURIComponent(schedulerConfig.primaryCalendarId)}/events/${encodeURIComponent(eventId)}${query}`;
  const response = await boundedFetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } }); return jsonResponse(response, "google_event");
}

export async function verifyCalCreatedGoogleEvent(env: Env, booking: VerifiedBooking, input: BookingInput): Promise<{ eventId: string; meetUrl: string }> {
  const token = await googleAccessToken(env); let lastError: unknown;
  for (const delay of [0, 250, 750, 1500, 3000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const verified = await googleEventRequest(env, token, booking.googleEventId);
      const attendees = Array.isArray(verified.attendees) ? verified.attendees.flatMap((item) => addresses(item).map((person) => person.email)).filter(isHuman) : [];
      const start = String((verified.start as Record<string, unknown> | undefined)?.dateTime ?? ""); const end = String((verified.end as Record<string, unknown> | undefined)?.dateTime ?? ""); const description = String(verified.description ?? ""); const meetUrl = googleMeetUrl(verified);
      if (String(verified.status ?? "") !== "confirmed") throw new Error("google_event_not_confirmed");
      if (String(verified.summary ?? "") !== booking.title || !description.includes(input.purpose) || !description.includes(input.title)) throw new Error("cal_content_not_propagated_to_google");
      if (Date.parse(start) !== Date.parse(input.start) || (Date.parse(end) - Date.parse(start)) / 60_000 !== input.durationMinutes) throw new Error("google_event_time_mismatch");
      const allowedAttendees = unique([...input.expectedAttendees, schedulerConfig.primaryCalendarId.toLowerCase()]);
      if (!input.expectedAttendees.every((email) => attendees.includes(email)) || !attendees.every((email) => allowedAttendees.includes(email))) throw new Error("google_event_attendee_mismatch");
      if (String(verified.iCalUID ?? "") !== booking.icsUid || !meetUrl) throw new Error("google_event_identity_or_meet_mismatch");
      return { eventId: booking.googleEventId, meetUrl };
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("cal_created_google_event_missing");
}

export const productionDeps: RuntimeDeps = { now: () => new Date(), plan, composeReply, freeBusy, replyAll, createAndVerifyBooking, getAndVerifyExistingBooking, verifyCalCreatedGoogleEvent, getThread };
export function allRecipientsDelivered(state: ThreadState): boolean { return state.expectedRecipients.length > 0 && state.expectedRecipients.every((recipient) => state.deliveredRecipients.includes(recipient)) }
