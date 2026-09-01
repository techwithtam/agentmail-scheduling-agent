/**
 * Public, non-secret scheduler configuration.
 *
 * An adapting agent should replace every value marked REPLACE_ME before
 * deployment. Keep credentials out of this file; Wrangler secrets hold those.
 */
export const schedulerConfig = {
  ownerName: "Alex",
  agentName: "Casey",
  schedulerInbox: "scheduler@example.agentmail.to",
  primaryCalendarId: "owner@example.com",
  alertEmail: "owner@example.com",
  ownerTimeZone: "America/Los_Angeles",
  ownerTimeZoneLabel: "PT",
  workersAiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  calSlotsApiVersion: "2024-09-04",
  calBookingsApiVersion: "2026-02-25",
  eventTypeIds: {
    15: -15,
    30: -30,
    45: -45,
    60: -60,
  } as Record<number, number>,
  minimumLeadHours: 24,
  maximumProposalRounds: 2,
  defaultDurationMinutes: 30,
  businessStartHour: 10,
  earliestExplicitHour: 8,
  businessEndHour: 17,
  allowedWeekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
} as const;

export function assertConfigured(): void {
  const values = [
    schedulerConfig.ownerName,
    schedulerConfig.agentName,
    schedulerConfig.schedulerInbox,
    schedulerConfig.primaryCalendarId,
    schedulerConfig.alertEmail,
  ];
  if (values.some((value) => /REPLACE_ME|replace-me|example\./i.test(value))) {
    throw new Error("scheduler_config_contains_placeholders");
  }
  if (Object.values(schedulerConfig.eventTypeIds).some((value) => value <= 0)) {
    throw new Error("scheduler_config_has_invalid_event_type_id");
  }
}
