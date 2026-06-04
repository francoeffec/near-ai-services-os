const { firstNonEmpty, splitName } = require("../domain/normalize");

function normalizeBooking(payload) {
  const booking = payload.booking || payload.event || payload.meeting || payload;
  const prospect = booking.prospect || booking.guest || booking.invitee || booking.contact || payload.prospect || {};
  const owner = booking.assignee || booking.host || booking.owner || booking.user || payload.assignee || payload.host || payload.owner || {};
  const fullName = firstNonEmpty(prospect.name, prospect.full_name, booking.name, payload.name);
  const split = splitName(fullName);
  const meetingType = firstNonEmpty(payload.campaign, booking.campaign, booking.meeting_type, booking.event_type, booking.title, payload.meeting_type, payload.event_type);

  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.id, booking.id, booking.event_id),
    eventSource: "Chili Piper",
    company: firstNonEmpty(prospect.company, prospect.company_name, booking.company, payload.company),
    firstName: firstNonEmpty(prospect.first_name, payload.first_name, split.firstName),
    lastName: firstNonEmpty(prospect.last_name, payload.last_name, split.lastName),
    email: firstNonEmpty(prospect.email, booking.email, payload.email),
    source: firstNonEmpty(payload.lead_source, booking.lead_source, prospect.source, "Outreach"),
    campaign: meetingType,
    owner: firstNonEmpty(owner.name, owner.full_name, owner.display_name, payload.assignee_name, payload.host_name, booking.assignee_name, booking.host_name),
    callDate: firstNonEmpty(booking.start_time, booking.start, booking.date, payload.start_time),
    callBookedOn: firstNonEmpty(booking.booked_at, booking.bookedAt, booking.created_at, booking.createdAt, payload.booked_at, payload.created_at, payload.timestamp, payload.received_at),
    callStatus: "Scheduled",
    stage: "Call Booked",
    notes: firstNonEmpty(payload.notes, booking.notes, booking.description)
  };
}

function bookingIncluded(config, booking) {
  const matchers = config.booking?.titleMatch || [];
  if (matchers.length === 0) return true;
  const title = [
    booking.campaign,
    booking.meetingType,
    booking.eventType,
    booking.title
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return matchers.some((value) => title.includes(String(value || "").toLowerCase()));
}

module.exports = { bookingIncluded, normalizeBooking };
