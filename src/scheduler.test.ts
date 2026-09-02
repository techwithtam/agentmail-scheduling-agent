import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allRecipientsDelivered,
  createAndVerifyBooking,
  composeReply,
  emptyState,
  failureAlertDetails,
  failureAlertKey,
  freeBusy,
  hasMinimumLeadTime,
  humanParticipants,
  exactRequestedStart,
  plan as runPlanner,
  planningDateContext,
  processQueueEvent,
  replyAll,
  sendFailureAlert,
  startMatchesRequest,
  validCandidateStarts,
  verifyCalCreatedGoogleEvent,
  type Plan,
  type QueueEvent,
  type RuntimeDeps,
  type ThreadState,
} from "./scheduler";

const now = new Date("2026-08-31T19:00:00.000Z");

afterEach(() => vi.unstubAllGlobals());

function event(overrides: Partial<QueueEvent> = {}): QueueEvent {
  return {
    eventId: "evt-1",
    eventType: "message.received",
    inboxId: "scheduler@example.agentmail.to",
    threadId: "thread-1",
    messageId: "msg-2",
    recipients: [],
    ...overrides,
  };
}

function env(): Env {
  return {
    PRIMARY_CALENDAR_ID: "owner@example.com",
    SCHEDULER_INBOX_ID: "scheduler@example.agentmail.to",
  } as unknown as Env;
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    action: "propose",
    duration_minutes: 60,
    title: "Meeting",
    purpose: "Discuss the scheduling bot",
    timezone: "America/Los_Angeles",
    search_windows: [{ start: "2026-09-07T17:00:00.000Z", end: "2026-09-09T23:00:00.000Z" }],
    excluded_windows: [],
    proposed_starts: ["2026-09-07T17:00:00.000Z", "2026-09-07T18:00:00.000Z"],
    confirmed_start: null,
    ...overrides,
  };
}

function deps(thePlan: Plan, options: { freeBusyError?: boolean; createError?: boolean } = {}): RuntimeDeps {
  return {
    now: () => now,
    plan: vi.fn(async () => thePlan),
    composeReply: vi.fn(async (_env, brief) => {
      if (brief.kind === "proposal") return `Alex has availability for a ${brief.durationMinutes}-minute meeting on the following days:\n\n${(brief.slots ?? []).map((slot) => `- ${slot}`).join("\n")}\n\nCould you please let me know which of these options works best for you?\n\nThank you,\n\nCasey`;
      if (brief.kind === "clarification") return `${brief.question}\n\nCasey`;
      if (brief.kind === "unavailable") return `${brief.requestedSlot} is already booked. These are still open: ${(brief.alternatives ?? []).join(" or ")}. Would either work?\n\nCasey`;
      return `You’re confirmed for a ${brief.durationMinutes}-minute meeting with Alex on ${brief.requestedSlot}.\n\nGoogle Meet: ${brief.meetUrl}\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey`;
    }),
    freeBusy: vi.fn(async () => {
      if (options.freeBusyError) throw new Error("calendar access denied");
      return [];
    }),
    replyAll: vi.fn(async () => "sent-1"),
    createAndVerifyBooking: vi.fn(async () => {
      if (options.createError) throw new Error("timeout");
      return {
        uid: "cal-1",
        title: "Call with Alex: Guest",
        start: "2026-09-07T17:00:00.000Z",
        end: "2026-09-07T18:00:00.000Z",
        duration: 60,
        icsUid: "ical-1",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        googleEventId: "google-1",
      };
    }),
    getAndVerifyExistingBooking: vi.fn(async () => ({
      uid: "cal-existing",
      title: "Call with Alex: Guest",
      start: "2026-09-08T21:00:00.000Z",
      end: "2026-09-08T21:30:00.000Z",
      duration: 30,
      icsUid: "cal-existing@Cal.com",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      googleEventId: "google-existing",
    })),
    verifyCalCreatedGoogleEvent: vi.fn(async () => ({ eventId: "google-1", meetUrl: "https://meet.google.com/abc-defg-hij" })),
    getThread: vi.fn(async () => ({
      last_message_id: "msg-2",
      messages: [
        {
          message_id: "msg-1",
          from: [{ email: "team-member@example.com", name: "Jordan Lee" }],
          to: [{ email: "owner@example.com", name: "Alex" }],
          text: "Do you have time early next week?",
        },
        {
          message_id: "msg-2",
          from: [{ email: "owner@example.com", name: "Alex" }],
          to: [{ email: "scheduler@example.agentmail.to" }],
          cc: [{ email: "team-member@example.com" }],
          text: "Can you assist with a 60 minute meeting early next week?",
        },
      ],
    })),
  };
}

describe("priority windows", () => {
  it("treats early next week as Monday-Wednesday at 10am or later", () => {
    expect(startMatchesRequest("2026-09-07T16:00:00.000Z", "60 minutes early next week", now)).toBe(false);
    expect(startMatchesRequest("2026-09-07T17:00:00.000Z", "60 minutes early next week", now)).toBe(true);
    expect(startMatchesRequest("2026-09-10T17:00:00.000Z", "60 minutes early next week", now)).toBe(false);
  });

  it("fails closed when the AI window escapes the requested week", () => {
    const wrongModelPlan = plan({
      duration_minutes: 30,
      search_windows: [{ start: "2026-09-02T20:00:00.000Z", end: "2026-09-05T00:00:00.000Z" }],
      proposed_starts: ["2026-09-02T20:00:00.000Z"],
    });
    const starts = validCandidateStarts(wrongModelPlan, "Do you have availability next week in the afternoon?", now, 30);
    expect(starts).toEqual([]);
  });

  it("allows explicit 8am but fails closed before 8am", () => {
    expect(startMatchesRequest("2026-09-01T15:00:00.000Z", "Can we do 8am tomorrow?", now)).toBe(true);
    expect(startMatchesRequest("2026-09-01T14:00:00.000Z", "Can we do 7am tomorrow?", now)).toBe(false);
  });

  it("rejects an explicit tomorrow time that is less than 24 hours away", () => {
    const starts = validCandidateStarts(plan({
      duration_minutes: 30,
      search_windows: [{ start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T15:30:00.000Z" }],
      proposed_starts: [],
    }), "Can we do 8am tomorrow?", now, 30);
    expect(starts).toEqual([]);
  });

  it("requires exactly 24 hours of lead time for a candidate", () => {
    expect(hasMinimumLeadTime("2026-09-01T19:00:00.000Z", now)).toBe(true);
    expect(hasMinimumLeadTime("2026-09-01T18:59:59.999Z", now)).toBe(false);
  });

  it("keeps an explicit time range inside next week", () => {
    const starts = validCandidateStarts(plan({
      duration_minutes: 30,
      search_windows: [
        { start: "2026-09-07T21:00:00.000Z", end: "2026-09-07T22:00:00.000Z" },
        { start: "2026-09-08T21:00:00.000Z", end: "2026-09-08T22:00:00.000Z" },
      ],
      proposed_starts: [],
    }), "I am free between 2 and 3pm next week", now, 30);
    expect(starts.slice(0, 2)).toEqual(["2026-09-07T21:00:00.000Z", "2026-09-07T21:30:00.000Z"]);
    expect(starts.every((start) => {
      const hour = new Date(start).getUTCHours();
      return hour === 21;
    })).toBe(true);
  });

  it("honors AI-normalized final windows instead of parsing one exclusion phrase", () => {
    const starts = validCandidateStarts(plan({
      duration_minutes: 60,
      search_windows: [
        { start: "2026-09-07T17:00:00.000Z", end: "2026-09-07T19:00:00.000Z" },
        { start: "2026-09-08T17:00:00.000Z", end: "2026-09-08T19:00:00.000Z" },
        { start: "2026-09-09T17:00:00.000Z", end: "2026-09-09T19:00:00.000Z" },
        { start: "2026-09-10T17:00:00.000Z", end: "2026-09-10T19:00:00.000Z" },
        { start: "2026-09-11T17:00:00.000Z", end: "2026-09-11T19:00:00.000Z" },
      ],
      excluded_windows: [{ start: "2026-09-09T07:00:00.000Z", end: "2026-09-10T07:00:00.000Z" }],
      proposed_starts: ["2026-09-09T17:00:00.000Z", "2026-09-10T17:00:00.000Z"],
    }), "Hey, looking to schedule a meeting sometime next week. I'm unavailable on Wednesday. Probably need an hour to walk through a project and get some status updates.", now, 60);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((start) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long" }).format(new Date(start)) !== "Wednesday")).toBe(true);
    expect(starts).toContain("2026-09-10T17:00:00.000Z");
  });

  it("intersects AI windows with Alex's hard working-hour boundary", () => {
    const starts = validCandidateStarts(plan({
      duration_minutes: 60,
      search_windows: [{ start: "2026-09-07T16:00:00.000Z", end: "2026-09-07T19:00:00.000Z" }],
      proposed_starts: ["2026-09-07T16:00:00.000Z", "2026-09-07T17:00:00.000Z"],
    }), "Do you have an hour next week?", now, 60);
    expect(starts).not.toContain("2026-09-07T16:00:00.000Z");
    expect(starts).toContain("2026-09-07T17:00:00.000Z");
  });

  it("keeps separate AI windows separate instead of filling an excluded gap", () => {
    const starts = validCandidateStarts(plan({
      duration_minutes: 30,
      search_windows: [
        { start: "2026-09-07T17:00:00.000Z", end: "2026-09-07T18:00:00.000Z" },
        { start: "2026-09-07T20:00:00.000Z", end: "2026-09-07T21:00:00.000Z" },
      ],
      proposed_starts: ["2026-09-07T19:00:00.000Z"],
    }), "I can meet next Monday before 11am or after 1pm", now, 30);
    expect(starts).toEqual([
      "2026-09-07T17:00:00.000Z",
      "2026-09-07T17:30:00.000Z",
      "2026-09-07T20:00:00.000Z",
      "2026-09-07T20:30:00.000Z",
    ]);
  });
});

describe("AI scheduling planner", () => {
  it("builds exact Pacific reference dates before calling the AI", () => {
    expect(planningDateContext(now)).toEqual({
      timezone: "America/Los_Angeles",
      current_local_date: "2026-08-31",
      current_local_weekday: "Monday",
      current_local_time: "12:00",
      next_week: {
        monday: "2026-09-07",
        tuesday: "2026-09-08",
        wednesday: "2026-09-09",
        thursday: "2026-09-10",
        friday: "2026-09-11",
      },
      early_next_week: { start: "2026-09-07", end: "2026-09-09" },
    });
  });

  it("requires final allowed windows that apply exclusions before proposing", async () => {
    const output = plan({
      duration_minutes: 60,
      search_windows: [
        { start: "2026-09-07T17:00:00.000Z", end: "2026-09-07T23:00:00.000Z" },
        { start: "2026-09-08T17:00:00.000Z", end: "2026-09-08T23:00:00.000Z" },
        { start: "2026-09-10T17:00:00.000Z", end: "2026-09-10T23:00:00.000Z" },
      ],
      excluded_windows: [{ start: "2026-09-09T07:00:00.000Z", end: "2026-09-10T07:00:00.000Z" }],
    });
    const aiRun = vi.fn(async () => ({ response: JSON.stringify(output) }));
    await expect(runPlanner(
      { AI: { run: aiRun } } as unknown as Env,
      { messages: [{ text: "Next week works, though Wednesday is a wash." }] },
      emptyState(),
      now,
    )).resolves.toEqual(output);
    const prompt = String(aiRun.mock.calls[0][1]?.messages?.[0]?.content);
    expect(prompt).toContain("search_windows must be the final allowed windows");
    expect(prompt).toContain("Deterministic owner calendar context");
    expect(prompt).toContain('"current_local_date":"2026-08-31"');
    expect(prompt).toContain('"monday":"2026-09-07"');
    expect(prompt).toContain("Omit excluded time entirely");
    expect(prompt).toContain("Never expand a final allowed window");
    expect(prompt).toContain("return every stated unavailable day or interval in excluded_windows");
    expect(prompt).toContain("2pm works fine");
    expect(prompt).toContain("instead of matching a phrase list");
  });
});

describe("Cal.com availability", () => {
  it("uses Cal.com slots and treats missing candidates as unavailable", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: "success",
      data: {
        "2026-09-07": [{
          start: "2026-09-07T10:00:00.000-07:00",
          end: "2026-09-07T11:00:00.000-07:00",
        }],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const unavailable = await freeBusy(
      { CAL_COM_TOKEN: "test-token" } as Env,
      ["2026-09-07T17:00:00.000Z", "2026-09-07T18:00:00.000Z"],
      60,
    );
    expect(unavailable).toEqual([{ start: "2026-09-07T18:00:00.000Z", end: "2026-09-07T19:00:00.000Z" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/slots?");
    expect(String(url)).toContain("eventTypeId=-60");
    expect((init?.headers as Record<string, string>)["cal-api-version"]).toBe("2024-09-04");
  });
});

describe("AgentMail replies", () => {
  it("uses the reply-all endpoint and verifies both recipients", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ message_id: "sent-1", thread_id: "thread-1" }))
      .mockResolvedValueOnce(Response.json({
        message_id: "sent-1",
        to: ["contact@example.com", "owner@example.com"],
        cc: [],
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(replyAll({
      AGENTMAIL_API_KEY_SCHEDULER: "test-key", // pragma: allowlist secret
      SCHEDULER_INBOX_ID: "scheduler@example.agentmail.to",
    } as Env, "source-1", "Plain text reply", ["contact@example.com", "owner@example.com"]))
      .resolves.toBe("sent-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/messages/source-1/reply-all");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Plain text reply" });
  });

  it("sends a bounded failure alert to Alex and verifies the recipient", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ message_id: "alert-1", thread_id: "alert-thread" }))
      .mockResolvedValueOnce(Response.json({ message_id: "alert-1", to: ["owner@example.com"], cc: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendFailureAlert({
      AGENTMAIL_API_KEY_SCHEDULER: "test-key", // pragma: allowlist secret
      SCHEDULER_INBOX_ID: "scheduler@example.agentmail.to",
    } as Env, event({ threadId: "thread-private" }), {
      phase: "quarantined",
      error: "confirmation_does_not_match_exact_proposal",
    })).resolves.toBe("alert-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/messages/send");
    const body = JSON.parse(String(init?.body));
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.subject).toBe("Casey scheduler needs attention");
    expect(body.text).toContain("Thread: thread-private");
    expect(body.text).toContain("Failure: confirmation_does_not_match_exact_proposal");
    expect(body.text).not.toContain("email body");
  });

  it("alerts once per stable terminal failure and ignores failures from the alert thread itself", () => {
    const failed: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      expectedRecipients: ["guest@example.com"],
      lastError: "proposal_reply_uncertain: provider payload omitted",
    };
    const details = failureAlertDetails(failed, event());
    expect(details).toEqual({ phase: "quarantined", error: "proposal_reply_uncertain", bookingUid: undefined });
    expect(failureAlertKey(details!)).toBe("quarantined:proposal_reply_uncertain:none");
    expect(failureAlertDetails(emptyState(), event({ eventType: "message.bounced", reason: "alert bounced" }))).toBeNull();
  });

  it("alerts if a retried event finds an incomplete transaction checkpoint", () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "booking_created",
      bookingUid: "cal-existing",
    };
    expect(failureAlertDetails(state, event())).toEqual({
      phase: "incomplete_transaction",
      error: "stalled_booking_created",
      bookingUid: "cal-existing",
    });
  });
});

describe("conversational reply composer", () => {
  it("uses the dedicated voice prompt and returns a validated plain-text reply", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "You’re confirmed for a 30-minute meeting with Alex on Monday, September 7 at 12:00pm PT.\n\nGoogle Meet: https://meet.google.com/abc-defg-hij\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey",
    }) }));
    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "confirmation",
      timezone: "PT",
      durationMinutes: 30,
      requestedSlot: "Monday, September 7 at 12:00pm PT",
      meetUrl: "https://meet.google.com/abc-defg-hij",
    })).resolves.toBe("You’re confirmed for a 30-minute meeting with Alex on Monday, September 7 at 12:00pm PT.\n\nGoogle Meet: https://meet.google.com/abc-defg-hij\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey");
    const prompt = String(aiRun.mock.calls[0][1]?.messages?.[0]?.content);
    expect(prompt).toContain("experienced executive assistant");
    expect(prompt).toContain("start every bullet with a hyphen and one space");
    expect(prompt).not.toContain("learn more about Alex's services");
  });

  it("normalizes Markdown proposal markers into spaced plain-text bullets", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "Alex has availability next week for a 30-minute meeting on the following days:\n* Monday, September 7: 2:00pm or 3:30pm PT\n* Tuesday, September 8: 3:00pm or 4:30pm PT\n* Wednesday, September 9: 2:30pm or 4:30pm PT\nCould you please let me know which of these options works best for you?\n\nThank you,\n\nCasey",
    }) }));

    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "proposal",
      timezone: "PT",
      durationMinutes: 30,
      scope: "next week",
      slots: [
        "Monday, September 7: 2:00pm or 3:30pm PT",
        "Tuesday, September 8: 3:00pm or 4:30pm PT",
        "Wednesday, September 9: 2:30pm or 4:30pm PT",
      ],
    })).resolves.toBe("Alex has availability next week for a 30-minute meeting on the following days:\n\n- Monday, September 7: 2:00pm or 3:30pm PT\n- Tuesday, September 8: 3:00pm or 4:30pm PT\n- Wednesday, September 9: 2:30pm or 4:30pm PT\n\nCould you please let me know which of these options works best for you?\n\nThank you,\n\nCasey");
  });

  it("rejects proposal copy that describes the options as separate meetings", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "Alex has availability next week, and every meeting will be 30 minutes.\n\n- Monday, September 7: 2:00pm or 3:30pm PT\n- Tuesday, September 8: 3:00pm or 4:30pm PT\n\nWhich option works best?\n\nCasey",
    }) }));
    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "proposal",
      timezone: "PT",
      durationMinutes: 30,
      slots: [
        "Monday, September 7: 2:00pm or 3:30pm PT",
        "Tuesday, September 8: 3:00pm or 4:30pm PT",
      ],
    })).rejects.toThrow("reply_composer_proposal_voice");
  });

  it("rejects a reply that invents another day or time", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "You’re confirmed for a 30-minute meeting with Alex on Monday, September 7 at 12:00pm PT, with Tuesday at 2:00pm PT also open.\n\nGoogle Meet: https://meet.google.com/abc-defg-hij\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey",
    }) }));

    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "confirmation",
      timezone: "PT",
      durationMinutes: 30,
      requestedSlot: "Monday, September 7 at 12:00pm PT",
      meetUrl: "https://meet.google.com/abc-defg-hij",
    })).rejects.toThrow("reply_composer_missing_confirmation_facts");
  });

  it("rejects a confirmation compressed into one dense paragraph", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "Your meeting with Alex is confirmed for Monday, September 7 at 12:00pm PT for 30 minutes. You should have received the Cal.com invitation with the Google Meet link, and you can use it to reschedule or cancel.\n\nCasey",
    }) }));
    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "confirmation",
      timezone: "PT",
      durationMinutes: 30,
      requestedSlot: "Monday, September 7 at 12:00pm PT",
      meetUrl: "https://meet.google.com/abc-defg-hij",
    })).rejects.toThrow("reply_composer_confirmation_layout");
  });

  it("rejects a confirmation without the verified direct Meet link", async () => {
    const aiRun = vi.fn(async () => ({ response: JSON.stringify({
      text: "You’re confirmed for a 30-minute meeting with Alex on Monday, September 7 at 12:00pm PT.\n\nGoogle Meet: included in the Cal.com invitation\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey",
    }) }));
    await expect(composeReply({ AI: { run: aiRun } } as unknown as Env, {
      kind: "confirmation",
      timezone: "PT",
      durationMinutes: 30,
      requestedSlot: "Monday, September 7 at 12:00pm PT",
      meetUrl: "https://meet.google.com/abc-defg-hij",
    })).rejects.toThrow("reply_composer_missing_confirmation_facts");
  });
});

describe("Cal.com-owned booking", () => {
  it("sends the attendee-facing title and purpose to Cal.com", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "success", data: { uid: "cal-1" } }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ status: "success", data: {
        uid: "cal-1",
        title: "Call with Alex: Guest",
        description: "Topic: Introductory Call — Alex + Guest\nPurpose: Introductory call to learn more about Alex's services.",
        status: "accepted",
        start: "2026-09-07T17:00:00.000Z",
        end: "2026-09-07T17:30:00.000Z",
        duration: 30,
        metadata: { agentmail_thread_id: "thread-1", purpose: "Introductory call to learn more about Alex's services." },
        bookingFieldsResponses: { title: "Introductory Call — Alex + Guest", notes: "Topic: Introductory Call — Alex + Guest\nPurpose: Introductory call to learn more about Alex's services." },
        attendees: [{ email: "guest@example.com" }],
        guests: [],
        icsUid: "cal-1@Cal.com",
        location: "https://meet.google.com/abc-defg-hij",
      } }))
      .mockResolvedValueOnce(Response.json({ status: "success", data: [{ type: "google_calendar", eventUid: "google-1", destinationCalendarId: "owner@example.com" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      threadId: "thread-1",
      start: "2026-09-07T17:00:00.000Z",
      durationMinutes: 30,
      title: "Introductory Call — Alex + Guest",
      purpose: "Introductory call to learn more about Alex's services.",
      primaryAttendee: { name: "Guest", email: "guest@example.com" },
      guests: [],
      expectedAttendees: ["guest@example.com"],
    };
    await expect(createAndVerifyBooking({ CAL_COM_TOKEN: "test", PRIMARY_CALENDAR_ID: "owner@example.com" } as Env, input)).resolves.toEqual(expect.objectContaining({ uid: "cal-1", title: "Call with Alex: Guest", googleEventId: "google-1" }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.bookingFieldsResponses).toEqual({
      title: "Introductory Call — Alex + Guest",
      notes: expect.stringContaining("Introductory call to learn more about Alex's services."),
    });
  });

  it("verifies the Cal-created Google event without updating it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "google-token" }))
      .mockResolvedValueOnce(Response.json({
        status: "confirmed",
        summary: "Call with Alex: Guest",
        description: "Topic: Introductory Call — Alex + Guest\nPurpose: Introductory call to learn more about Alex's services.\n\nScheduled through Cal.com.",
        start: { dateTime: "2026-09-07T10:00:00-07:00" },
        end: { dateTime: "2026-09-07T10:30:00-07:00" },
        attendees: [{ email: "guest@example.com" }, { email: "owner@example.com" }],
        iCalUID: "cal-1@Cal.com",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
      }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyCalCreatedGoogleEvent({
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret", // pragma: allowlist secret
      GOOGLE_REFRESH_TOKEN: "refresh",
      PRIMARY_CALENDAR_ID: "owner@example.com",
    } as Env, {
      uid: "cal-1",
      title: "Call with Alex: Guest",
      start: "2026-09-07T17:00:00.000Z",
      end: "2026-09-07T17:30:00.000Z",
      duration: 30,
      icsUid: "cal-1@Cal.com",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      googleEventId: "google-1",
    }, {
      threadId: "thread-1",
      start: "2026-09-07T17:00:00.000Z",
      durationMinutes: 30,
      title: "Introductory Call — Alex + Guest",
      purpose: "Introductory call to learn more about Alex's services.",
      primaryAttendee: { name: "Guest", email: "guest@example.com" },
      guests: [],
      expectedAttendees: ["guest@example.com"],
    })).resolves.toEqual({ eventId: "google-1", meetUrl: "https://meet.google.com/abc-defg-hij" });
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});

describe("durable scheduling transaction", () => {
  it("replies to every human participant and replaces a generic title", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    expect(state.phase).toBe("proposed");
    expect(runtime.composeReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "proposal" }));
    expect(state.expectedRecipients).toEqual(["owner@example.com", "team-member@example.com"]);
    expect(state.title).not.toBe("Meeting");
    expect(runtime.replyAll).toHaveBeenCalledWith(
      expect.anything(),
      "msg-2",
      expect.stringContaining("Monday, September 7"),
      ["owner@example.com", "team-member@example.com"],
    );
  });

  it("generates candidates from a valid requested window when the model returns none", async () => {
    const state = emptyState();
    const runtime = deps(plan({
      title: "Introductory Call Availability",
      purpose: "This response proposes time slots for an introductory call.",
      search_windows: [
        { start: "2026-09-07T20:00:00.000Z", end: "2026-09-08T00:00:00.000Z" },
        { start: "2026-09-08T20:00:00.000Z", end: "2026-09-09T00:00:00.000Z" },
        { start: "2026-09-09T20:00:00.000Z", end: "2026-09-10T00:00:00.000Z" },
        { start: "2026-09-10T20:00:00.000Z", end: "2026-09-11T00:00:00.000Z" },
        { start: "2026-09-11T20:00:00.000Z", end: "2026-09-12T00:00:00.000Z" },
      ],
      proposed_starts: [],
    }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-2",
      messages: [{
        message_id: "msg-2",
        from: "Alex <guest@example.com>",
        to: [{ email: "owner@example.com" }, { email: "scheduler@example.agentmail.to" }],
        text: "I'd like an introductory call to learn more about your services. Do you have time next week in the afternoon?",
      }],
    }));
    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    expect(state.phase).toBe("proposed");
    expect(state.proposedStarts).toEqual([
      "2026-09-07T20:00:00.000Z",
      "2026-09-07T22:00:00.000Z",
      "2026-09-09T20:30:00.000Z",
      "2026-09-09T22:30:00.000Z",
      "2026-09-11T21:00:00.000Z",
      "2026-09-11T23:00:00.000Z",
    ]);
    const reply = String((runtime.replyAll as ReturnType<typeof vi.fn>).mock.calls[0][2]);
    expect(reply).toContain("- Monday, September 7: 1:00pm or 3:00pm PT");
    expect(reply).toContain("- Wednesday, September 9: 1:30pm or 3:30pm PT");
    expect(reply).toContain("- Friday, September 11: 2:00pm or 4:00pm PT");
    expect(reply).not.toContain("1:00pm-1:30pm");
    expect(state.title).not.toContain("Availability");
    expect(state.title).toBe("Introductory Call");
    expect(state.purpose).toBe("Introductory call to learn more about Alex's services.");
  });

  it("preserves the original meeting purpose when a follow-up narrows the day", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T20:00:00.000Z"],
      durationMinutes: 30,
      title: "Introductory Call — Alex + Guest",
      purpose: "Introductory call to learn more about Alex's services.",
    };
    const runtime = deps(plan({
      duration_minutes: 30,
      title: "Proposed Meeting Times for Tuesday",
      purpose: "Conversation requested by the attendees on the email thread.",
      search_windows: [{ start: "2026-09-08T17:00:00.000Z", end: "2026-09-08T23:00:00.000Z" }],
      proposed_starts: ["2026-09-08T17:00:00.000Z", "2026-09-08T18:30:00.000Z"],
    }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-3",
      subject: "meeting request",
      messages: [
        { message_id: "msg-1", from: "Guest <guest@example.com>", to: ["owner@example.com", "scheduler@example.agentmail.to"], text: "I'd like an introductory call to learn more about your services next week." },
        { message_id: "msg-3", from: "Guest <guest@example.com>", to: ["owner@example.com", "scheduler@example.agentmail.to"], text: "What does your availability look like on Tuesday?" },
      ],
    }));
    await processQueueEvent(env(), state, event({ eventId: "evt-tuesday", messageId: "msg-3" }), async () => undefined, runtime);
    expect(state.phase).toBe("proposed");
    expect(state.title).toBe("Introductory Call — Alex + Guest");
    expect(state.purpose).toBe("Introductory call to learn more about Alex's services.");
  });

  it("leaves availability failures retryable before any mutation", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    runtime.freeBusy = vi.fn()
      .mockRejectedValueOnce(new Error("calendar access denied"))
      .mockResolvedValue([]);
    await expect(processQueueEvent(env(), state, event(), async () => undefined, runtime)).rejects.toThrow("cal_availability_retryable:freebusy");
    expect(state.phase).toBe("idle");
    expect(state.processedEventIds).not.toContain("evt-1");
    expect(runtime.replyAll).not.toHaveBeenCalled();

    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    expect(state.phase).toBe("proposed");
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it("recovers only a legacy pre-mutation availability quarantine with a new event", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      processedEventIds: ["evt-old"],
      lastError: "freebusy_failed_closed: cal_slots_timeout",
    };
    const runtime = deps(plan());

    await processQueueEvent(env(), state, event({ eventId: "evt-recovery" }), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    expect(state.lastError).toBeUndefined();
    expect(state.processedEventIds).toEqual(["evt-old", "evt-recovery"]);
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it.each(["planner_returned_no_valid_candidates", "no_available_valid_candidates"])(
    "can re-evaluate the pre-mutation planner failure %s after logic changes",
    async (lastError) => {
      const state: ThreadState = {
        ...emptyState(),
        phase: "quarantined",
        processedEventIds: ["evt-old"],
        lastError,
      };
      const runtime = deps(plan());

      await processQueueEvent(env(), state, event({ eventId: "evt-recovery" }), async () => undefined, runtime);

      expect(state.phase).toBe("proposed");
      expect(runtime.replyAll).toHaveBeenCalledTimes(1);
    },
  );

  it("does not recover the already-processed legacy event id", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      processedEventIds: ["evt-old"],
      lastError: "freebusy_failed_closed: cal_slots_timeout",
    };
    const runtime = deps(plan());

    await processQueueEvent(env(), state, event({ eventId: "evt-old" }), async () => undefined, runtime);

    expect(state.phase).toBe("quarantined");
    expect(runtime.replyAll).not.toHaveBeenCalled();
  });

  it("never reopens a quarantine that may have crossed an external mutation boundary", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      processedEventIds: ["evt-old"],
      lastError: "freebusy_failed_closed: legacy error",
      bookingUid: "cal-existing",
    };
    const runtime = deps(plan());

    await processQueueEvent(env(), state, event({ eventId: "evt-recovery" }), async () => undefined, runtime);

    expect(state.phase).toBe("quarantined");
    expect(runtime.replyAll).not.toHaveBeenCalled();
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
  });

  it("composes clarification questions through the same reply writer", async () => {
    const state = emptyState();
    const runtime = deps(plan({ action: "clarify", proposed_starts: [], confirmed_start: null }));

    await processQueueEvent(env(), state, event({ eventId: "evt-clarify" }), async () => undefined, runtime);

    expect(state.phase).toBe("clarified");
    expect(runtime.composeReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: "clarification",
      question: "What day or time window would work best for the meeting?",
    }));
    expect(runtime.replyAll).toHaveBeenCalledWith(
      expect.anything(),
      "msg-2",
      "What day or time window would work best for the meeting?\n\nCasey",
      ["owner@example.com", "team-member@example.com"],
    );
  });

  it("uses the professional fallback when composed wording is too casual", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    runtime.composeReply = vi.fn(async (_env, brief) => `A few times early next week could work:\n\n${(brief.slots ?? []).map((slot) => `- ${slot}`).join("\n")}\n\nDo any of those work for you? I can send the invite once you pick one.\n\nCasey`);

    await processQueueEvent(env(), state, event({ eventId: "evt-invalid-copy" }), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    const reply = String((runtime.replyAll as ReturnType<typeof vi.fn>).mock.calls[0][2]);
    expect(reply).toContain("Alex has availability early next week for a 60-minute meeting");
    expect(reply).toContain("Monday, September 7");
    expect(reply).toContain("Could you please let me know which of these options works best for you?");
    expect(reply).toContain("Thank you,\n\nCasey");
    expect(reply).not.toContain("could work");
    expect(reply).not.toContain("pick one");
  });

  it("speaks as Alex's chief of staff in a one-day proposal", async () => {
    const state = emptyState();
    const runtime = deps(plan({
      duration_minutes: 30,
      search_windows: [
        { start: "2026-09-08T17:30:00.000Z", end: "2026-09-08T18:00:00.000Z" },
        { start: "2026-09-08T21:00:00.000Z", end: "2026-09-08T21:30:00.000Z" },
      ],
      proposed_starts: ["2026-09-08T17:30:00.000Z", "2026-09-08T21:00:00.000Z"],
    }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-2",
      messages: [{
        message_id: "msg-2",
        timestamp: "2026-08-31T21:40:00.000Z",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "Does Alex have any time on Tuesday?",
      }],
    }));
    runtime.composeReply = vi.fn(async () => "Tuesday is available at 10:30am or 2:00pm PT. Would either time work for you?\n\nCasey");

    await processQueueEvent(env(), state, event(), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    const reply = String((runtime.replyAll as ReturnType<typeof vi.fn>).mock.calls[0][2]);
    expect(reply).toBe("Alex has availability for a 30-minute meeting on Tuesday at 10:30am or 2:00pm PT. Would either time work for you?\n\nThank you,\n\nCasey");
    expect(reply).not.toContain("Tuesday is available");
  });

  it("keeps an adjacent candidate when only the exact prior start is unavailable", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    runtime.freeBusy = vi.fn(async () => [{
      start: "2026-09-07T17:00:00.000Z",
      end: "2026-09-07T18:00:00.000Z",
    }]);
    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    expect(state.proposedStarts[0]).toBe("2026-09-07T17:30:00.000Z");
    expect(state.proposedStarts).not.toContain("2026-09-07T17:00:00.000Z");
  });

  it("keeps hourly Cal.com matches when adjacent half-hour starts are unavailable", async () => {
    const state = emptyState();
    const runtime = deps(plan({
      duration_minutes: 60,
      search_windows: [{ start: "2026-09-07T17:00:00.000Z", end: "2026-09-07T21:00:00.000Z" }],
      proposed_starts: [],
    }));
    runtime.freeBusy = freeBusy;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "success",
      data: {
        "2026-09-07": [
          { start: "2026-09-07T11:00:00.000-07:00", end: "2026-09-07T12:00:00.000-07:00" },
          { start: "2026-09-07T12:00:00.000-07:00", end: "2026-09-07T13:00:00.000-07:00" },
          { start: "2026-09-07T13:00:00.000-07:00", end: "2026-09-07T14:00:00.000-07:00" },
        ],
      },
    })));

    await processQueueEvent(env(), state, event({ eventId: "evt-hourly-grid" }), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    expect(state.proposedStarts).toEqual(["2026-09-07T18:00:00.000Z", "2026-09-07T20:00:00.000Z"]);
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it("does not run the same webhook twice", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    await processQueueEvent(env(), state, event(), async () => undefined, runtime);
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it("books the exact AI-selected proposal for a natural-language acceptance", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-08T21:00:00.000Z"],
      durationMinutes: 60,
      title: "Jordan Lee + Alex: Scheduling bot review",
      purpose: "Discuss the scheduling bot",
    };
    const runtime = deps(plan({ action: "book", confirmed_start: "2026-09-08T21:00:00.000Z", proposed_starts: [] }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-2",
      messages: [
        { message_id: "msg-1", from: [{ email: "owner@example.com" }], to: [{ email: "scheduler@example.agentmail.to" }], cc: [{ email: "guest@example.com" }], text: "Please assist" },
        { message_id: "msg-2", from: [{ email: "guest@example.com", name: "Guest" }], to: [{ email: "owner@example.com" }, { email: "scheduler@example.agentmail.to" }], text: "2pm pt works fine" },
      ],
    }));
    await processQueueEvent(env(), state, event({ eventId: "evt-confirm" }), async () => undefined, runtime);
    expect(state.phase).toBe("booked");
    expect(runtime.composeReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "confirmation" }));
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledTimes(1);
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: "2026-09-08T21:00:00.000Z" }));
    expect(runtime.verifyCalCreatedGoogleEvent).toHaveBeenCalledTimes(1);
    expect(runtime.replyAll).toHaveBeenCalledWith(expect.anything(), "msg-2", expect.stringContaining("Google Meet"), ["guest@example.com", "owner@example.com"]);
  });

  it("books a newly requested exact Pacific time without asking for another confirmation", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T18:00:00.000Z", "2026-09-07T18:30:00.000Z"],
      durationMinutes: 30,
      title: "Introductory Call",
      purpose: "Introductory call to learn more about Alex's services.",
    };
    const runtime = deps(plan({
      action: "propose",
      duration_minutes: 30,
      proposed_starts: ["2026-09-07T19:00:00.000Z"],
      confirmed_start: null,
    }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-3",
      subject: "Intro meeting",
      messages: [
        { message_id: "msg-1", from: "Guest <guest@example.com>", to: ["owner@example.com", "scheduler@example.agentmail.to"], text: "Could we set up a 30-minute intro call next week?" },
        { message_id: "msg-3", timestamp: "2026-08-31T21:40:00.000Z", from: "Guest <guest@example.com>", to: ["owner@example.com", "scheduler@example.agentmail.to"], text: "How about Monday at 12 p.m. Pacific?" },
      ],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-direct", messageId: "msg-3" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(runtime.freeBusy).toHaveBeenCalledWith(expect.anything(), ["2026-09-07T19:00:00.000Z"], 30);
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      start: "2026-09-07T19:00:00.000Z",
      durationMinutes: 30,
      title: "Introductory Call",
    }));
    const reply = String((runtime.replyAll as ReturnType<typeof vi.fn>).mock.calls[0][2]);
    expect(reply).toBe("You’re confirmed for a 30-minute meeting with Alex on Monday, September 7 at 12:00pm PT.\n\nGoogle Meet: https://meet.google.com/abc-defg-hij\n\nIf anything changes, you can reschedule or cancel from the Cal.com invitation in your inbox.\n\nCasey");
    expect(reply.match(/Monday, September 7 at 12:00pm PT/g)).toHaveLength(1);
    expect(reply).not.toMatch(/^-/m);
    expect(reply).not.toContain("learn more about Alex's services");
    expect(reply).not.toContain("Which one works");
    expect(reply).not.toContain("Alex is available");
  });

  it("inherits the timezone from an active proposal for a newly requested exact time", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T21:00:00.000Z", "2026-09-07T22:30:00.000Z"],
      durationMinutes: 30,
      title: "Meeting request — Alex + Guest",
      purpose: "Discuss the meeting request.",
    };
    const runtime = deps(plan({
      action: "propose",
      duration_minutes: 30,
      proposed_starts: ["2026-09-07T22:00:00.000Z"],
      confirmed_start: null,
    }));
    runtime.now = vi.fn(() => new Date("2026-09-01T20:12:00.000Z"));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-alternate",
      subject: "Meeting request",
      messages: [{
        message_id: "msg-alternate",
        timestamp: "2026-09-01T20:11:00.000Z",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "available monday at 3pm by chance?",
      }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-alternate", messageId: "msg-alternate" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(runtime.freeBusy).toHaveBeenCalledWith(expect.anything(), ["2026-09-07T22:00:00.000Z"], 30);
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      start: "2026-09-07T22:00:00.000Z",
      durationMinutes: 30,
    }));
  });

  it("recovers an alternate-time quarantine when a new inbound message retries the exact time", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      proposedStarts: ["2026-09-07T21:00:00.000Z", "2026-09-07T22:30:00.000Z"],
      durationMinutes: 30,
      title: "Meeting request — Alex + Guest",
      purpose: "Discuss the meeting request.",
      lastError: "confirmation_does_not_match_exact_proposal",
    };
    const runtime = deps(plan({
      action: "propose",
      duration_minutes: 30,
      proposed_starts: ["2026-09-07T22:00:00.000Z"],
      confirmed_start: null,
    }));
    runtime.now = vi.fn(() => new Date("2026-09-01T20:21:00.000Z"));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-retry",
      subject: "Meeting request",
      messages: [{
        message_id: "msg-retry",
        timestamp: "2026-09-01T20:20:00.000Z",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "Can you check Monday at 3pm again?",
      }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-retry", messageId: "msg-retry" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(state.lastError).toBeUndefined();
    expect(runtime.freeBusy).toHaveBeenCalledWith(expect.anything(), ["2026-09-07T22:00:00.000Z"], 30);
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledTimes(1);
  });

  it("converts an exact Eastern-time request before applying Pacific working hours", async () => {
    expect(exactRequestedStart("How about Wednesday at 4pm ET?", now)).toBe("2026-09-02T20:00:00.000Z");
    expect(exactRequestedStart("How about Wednesday at 4pm?", now)).toBeNull();
    expect(exactRequestedStart("How about tomorrow at 10am ET?", new Date("2026-09-01T06:30:00.000Z"))).toBe("2026-09-02T14:00:00.000Z");

    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T18:00:00.000Z"],
      durationMinutes: 30,
      title: "Introductory Call",
      purpose: "Introductory call to learn more about Alex's services.",
    };
    const runtime = deps(plan({ action: "propose", duration_minutes: 30, proposed_starts: [], confirmed_start: null }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-et",
      messages: [{
        message_id: "msg-et",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "How about Wednesday at 4pm ET?",
      }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-et", messageId: "msg-et" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: "2026-09-02T20:00:00.000Z" }));
  });

  it("uses an unambiguous timezone established earlier in the same thread", async () => {
    const state = emptyState();
    const runtime = deps(plan({ action: "propose", duration_minutes: 30, proposed_starts: [], confirmed_start: null }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-established-zone",
      messages: [
        {
          message_id: "msg-zone-context",
          from: "Guest <guest@example.com>",
          to: ["owner@example.com", "scheduler@example.agentmail.to"],
          text: "I am on Eastern Time.",
        },
        {
          message_id: "msg-established-zone",
          from: "Guest <guest@example.com>",
          to: ["owner@example.com", "scheduler@example.agentmail.to"],
          text: "How about Wednesday at 4pm?",
        },
      ],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-established-zone", messageId: "msg-established-zone" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: "2026-09-02T20:00:00.000Z" }));
  });

  it("uses only the latest message's current recipients", async () => {
    const state = emptyState();
    const runtime = deps(plan());
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-current",
      messages: [
        {
          message_id: "msg-old",
          from: "Former Guest <former@example.com>",
          to: ["owner@example.com", "scheduler@example.agentmail.to"],
          cc: ["old-team@example.com"],
          text: "Please schedule us next week.",
        },
        {
          message_id: "msg-current",
          from: "Current Guest <current@example.com>",
          to: ["scheduler@example.agentmail.to"],
          cc: ["owner@example.com", "no-reply@updates.example.com"],
          text: "Do you have time next week?",
        },
      ],
    }));

    expect(humanParticipants({
      from: "Current Guest <current@example.com>",
      to: ["scheduler@example.agentmail.to"],
      cc: ["owner@example.com", "no-reply@updates.example.com"],
    })).toEqual([
      { email: "current@example.com", name: "Current Guest" },
      { email: "owner@example.com" },
    ]);
    await processQueueEvent(env(), state, event({ eventId: "evt-current", messageId: "msg-current" }), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    expect(state.expectedRecipients).toEqual(["current@example.com", "owner@example.com"]);
    expect(runtime.replyAll).toHaveBeenCalledWith(expect.anything(), "msg-current", expect.any(String), ["current@example.com", "owner@example.com"]);
    expect(state.expectedRecipients).not.toContain("former@example.com");
    expect(state.expectedRecipients).not.toContain("old-team@example.com");
  });

  it("stops after two proposal rounds and asks for an exact time", async () => {
    const state: ThreadState = { ...emptyState(), phase: "proposed", proposalRounds: 2, proposedStarts: ["2026-09-07T17:00:00.000Z"] };
    const runtime = deps(plan({ action: "propose" }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-round-3",
      messages: [{
        message_id: "msg-round-3",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "Neither works. Do you have other availability?",
      }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-round-3", messageId: "msg-round-3" }), async () => undefined, runtime);

    expect(state.phase).toBe("clarified");
    expect(state.proposalRounds).toBe(2);
    expect(runtime.freeBusy).not.toHaveBeenCalled();
    expect(runtime.replyAll).toHaveBeenCalledWith(expect.anything(), "msg-round-3", expect.stringContaining("exact date and time at least 24 hours"), ["guest@example.com", "owner@example.com"]);
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
  });

  it("answers an unavailable exact request directly instead of repeating the availability template", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T18:00:00.000Z", "2026-09-07T18:30:00.000Z"],
      durationMinutes: 30,
      title: "Introductory Call",
      purpose: "Introductory call to learn more about Alex's services.",
    };
    const runtime = deps(plan({ action: "propose", duration_minutes: 30, proposed_starts: ["2026-09-07T19:00:00.000Z"] }));
    runtime.freeBusy = vi.fn(async (_env, starts) => starts.includes("2026-09-07T19:00:00.000Z")
      ? [{ start: "2026-09-07T19:00:00.000Z", end: "2026-09-07T19:30:00.000Z" }]
      : []);
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-3",
      messages: [{ message_id: "msg-3", from: "Guest <guest@example.com>", to: ["owner@example.com", "scheduler@example.agentmail.to"], text: "How about Monday at 12 p.m. Pacific?" }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-direct-busy", messageId: "msg-3" }), async () => undefined, runtime);

    expect(state.phase).toBe("proposed");
    expect(runtime.composeReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "unavailable" }));
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
    const reply = String((runtime.replyAll as ReturnType<typeof vi.fn>).mock.calls[0][2]);
    expect(reply).toContain("Monday, September 7 at 12:00pm PT is already booked");
    expect(reply).toContain("Monday, September 7 at 11:00am PT or Monday, September 7 at 11:30am PT");
    expect(reply).not.toContain("Alex is available");
  });

  it("accepts an exact proposed instant expressed with a timezone offset", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-07T17:00:00.000Z"],
      durationMinutes: 60,
      title: "Guest + Alex: Review",
      purpose: "Review the services",
    };
    const runtime = deps(plan({ action: "book", confirmed_start: "2026-09-07T10:00:00-07:00", proposed_starts: [] }));
    runtime.getThread = vi.fn(async () => ({ last_message_id: "msg-2", messages: [{ message_id: "msg-2", from: [{ email: "guest@example.com" }], to: [{ email: "owner@example.com" }, { email: "scheduler@example.agentmail.to" }], text: "Yes, that works" }] }));
    await processQueueEvent(env(), state, event({ eventId: "evt-offset" }), async () => undefined, runtime);
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: "2026-09-07T17:00:00.000Z" }));
  });

  it("does not book a previously proposed slot once it is inside the 24-hour lead window", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "proposed",
      proposedStarts: ["2026-09-01T18:00:00.000Z"],
      durationMinutes: 30,
      title: "Review",
      purpose: "Review the services",
    };
    const runtime = deps(plan({ action: "book", duration_minutes: 30, confirmed_start: "2026-09-01T18:00:00.000Z", proposed_starts: [] }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-too-soon",
      messages: [{
        message_id: "msg-too-soon",
        from: "Guest <guest@example.com>",
        to: ["owner@example.com", "scheduler@example.agentmail.to"],
        text: "Yes, that works.",
      }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-too-soon", messageId: "msg-too-soon" }), async () => undefined, runtime);

    expect(state.phase).toBe("clarified");
    expect(state.lastError).toBeUndefined();
    expect(runtime.replyAll).toHaveBeenCalledWith(expect.anything(), "msg-too-soon", expect.stringContaining("now within 24 hours"), ["guest@example.com", "owner@example.com"]);
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
  });

  it("respects the AI decision that try again is a new proposal request", async () => {
    const state: ThreadState = { ...emptyState(), phase: "proposed", proposedStarts: ["2026-09-07T17:00:00.000Z"], durationMinutes: 60, title: "Review", purpose: "Review" };
    const runtime = deps(plan({ action: "propose", confirmed_start: null }));
    runtime.getThread = vi.fn(async () => ({ last_message_id: "msg-2", messages: [{ message_id: "msg-2", from: [{ email: "guest@example.com" }], to: [{ email: "scheduler@example.agentmail.to" }], text: "Try again" }] }));
    await processQueueEvent(env(), state, event({ eventId: "evt-retry" }), async () => undefined, runtime);
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it("quarantines a book action outside the proposed state instead of failing silently", async () => {
    const state = emptyState();
    const runtime = deps(plan({ action: "book", confirmed_start: "2026-09-07T17:00:00.000Z" }));
    runtime.getThread = vi.fn(async () => ({ last_message_id: "msg-2", messages: [{ message_id: "msg-2", from: [{ email: "guest@example.com" }], to: [{ email: "scheduler@example.agentmail.to" }], text: "That time is fine" }] }));
    await processQueueEvent(env(), state, event({ eventId: "evt-unsafe-book" }), async () => undefined, runtime);
    expect(state.phase).toBe("quarantined");
    expect(state.lastError).toBe("book_action_without_proposed_state");
    expect(state.processedEventIds).toContain("evt-unsafe-book");
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
  });

  it("quarantines an uncertain Cal create and never retries", async () => {
    const state: ThreadState = { ...emptyState(), phase: "proposed", proposedStarts: ["2026-09-07T17:00:00.000Z"], durationMinutes: 60, title: "Review", purpose: "Review" };
    const runtime = deps(plan({ action: "book", confirmed_start: "2026-09-07T17:00:00.000Z" }), { createError: true });
    runtime.getThread = vi.fn(async () => ({ last_message_id: "msg-2", messages: [{ message_id: "msg-2", from: [{ email: "guest@example.com" }], to: [{ email: "owner@example.com" }, { email: "scheduler@example.agentmail.to" }], text: "Yes, book it" }] }));
    await processQueueEvent(env(), state, event({ eventId: "evt-create" }), async () => undefined, runtime);
    await processQueueEvent(env(), state, event({ eventId: "evt-create" }), async () => undefined, runtime);
    expect(state.phase).toBe("quarantined");
    expect(runtime.createAndVerifyBooking).toHaveBeenCalledTimes(1);
  });

  it("resumes verification of the existing Cal.com booking without creating a duplicate", async () => {
    const state: ThreadState = {
      ...emptyState(),
      phase: "quarantined",
      proposedStarts: ["2026-09-08T17:30:00.000Z", "2026-09-08T21:00:00.000Z"],
      durationMinutes: 30,
      title: "Podcast Discussion",
      purpose: "Discuss the podcast",
      sourceMessageId: "msg-2",
      bookingUid: "cal-existing",
      lastError: "cal_created_google_verification_failed: google_event_attendee_mismatch",
      expectedRecipients: ["guest@example.com"],
    };
    const runtime = deps(plan({ action: "book", duration_minutes: 30, confirmed_start: "2026-09-08T21:00:00.000Z", proposed_starts: [] }));
    runtime.getThread = vi.fn(async () => ({
      last_message_id: "msg-2",
      messages: [{ message_id: "msg-2", from: [{ email: "guest@example.com", name: "Guest" }], to: [{ email: "scheduler@example.agentmail.to" }], text: "2pm pt works fine" }],
    }));

    await processQueueEvent(env(), state, event({ eventId: "evt-resume-existing" }), async () => undefined, runtime);

    expect(state.phase).toBe("booked");
    expect(state.bookingUid).toBe("cal-existing");
    expect(runtime.createAndVerifyBooking).not.toHaveBeenCalled();
    expect(runtime.getAndVerifyExistingBooking).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ start: "2026-09-08T21:00:00.000Z" }), "cal-existing");
    expect(runtime.verifyCalCreatedGoogleEvent).toHaveBeenCalledTimes(1);
    expect(runtime.replyAll).toHaveBeenCalledTimes(1);
  });

  it("marks delivery complete only after every expected recipient is observed", async () => {
    const state: ThreadState = { ...emptyState(), expectedRecipients: ["a@example.com", "b@example.com"] };
    const runtime = deps(plan());
    await processQueueEvent(env(), state, event({ eventId: "del-1", eventType: "message.delivered", recipients: ["a@example.com"] }), async () => undefined, runtime);
    expect(allRecipientsDelivered(state)).toBe(false);
    await processQueueEvent(env(), state, event({ eventId: "del-2", eventType: "message.delivered", recipients: ["b@example.com"] }), async () => undefined, runtime);
    expect(allRecipientsDelivered(state)).toBe(true);
  });
});
