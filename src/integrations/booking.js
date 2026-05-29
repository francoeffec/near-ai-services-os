const { firstNonEmpty, splitName } = require("../domain/normalize");

function normalizeBooking(payload) {
  const booking = payload.booking || payload.event || payload.meeting || payload;
  const prospect = booking.prospect || booking.guest || booking.invitee || booking.contact || payload.prospect || {};
  const fullName = firstNonEmpty(prospect.name, prospect.full_name, booking.name, payload.name);
  const split = splitName(fullName);

  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.id, booking.id, booking.event_id),
    company: firstNonEmpty(prospect.company, prospect.company_name, booking.company, payload.company),
    firstName: firstNonEmpty(prospect.first_name, payload.first_name, split.firstName),
    lastName: firstNonEmpty(prospect.last_name, payload.last_name, split.lastName),
    email: firstNonEmpty(prospect.email, booking.email, payload.email),
    source: firstNonEmpty(payload.source, booking.source, "Chili Piper"),
    campaign: firstNonEmpty(payload.campaign, booking.campaign, booking.meeting_type, booking.event_type),
    callDate: firstNonEmpty(booking.start_time, booking.start, booking.date, payload.start_time),
    callStatus: "Scheduled",
    stage: "Call Booked",
    notes: firstNonEmpty(payload.notes, booking.notes, booking.description)
  };
}

module.exports = { normalizeBooking };
