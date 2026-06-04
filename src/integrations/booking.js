const { firstNonEmpty, splitName } = require("../domain/normalize");

function joinName(...values) {
  return values.map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function timestampValue(...values) {
  const value = firstNonEmpty(...values);
  if (/^\d{10,13}$/.test(value)) {
    const millis = value.length === 10 ? Number(value) * 1000 : Number(value);
    return new Date(millis).toISOString();
  }
  return value;
}

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

function normalizeHubSpotMeeting(payload) {
  const object = payload.object || {};
  const inputFields = payload.inputFields || payload.inputs || {};
  const properties = payload.properties || object.properties || payload.meeting?.properties || {};
  const contact = payload.contact || payload.prospect || payload.invitee || payload.guest || {};
  const company = payload.company || {};
  const owner = payload.owner || payload.host || payload.assignee || {};
  const fullName = firstNonEmpty(
    contact.name,
    contact.full_name,
    inputFields.contact_name,
    inputFields.full_name,
    properties.fullname,
    joinName(properties.firstname, properties.lastname),
    joinName(inputFields.first_name, inputFields.last_name),
    payload.name
  );
  const split = splitName(fullName);
  const objectType = String(object.objectType || "").toLowerCase();
  const objectId = firstNonEmpty(
    inputFields.meeting_id,
    properties.hs_object_id,
    ["meeting", "meetings", "0-47"].includes(objectType) ? object.objectId : "",
    payload.meeting_id,
    payload.id
  );
  const meetingType = firstNonEmpty(
    inputFields.meeting_type,
    inputFields.meeting_name,
    inputFields.meeting_title,
    properties.hs_meeting_title,
    properties.hs_activity_type,
    properties.hs_meeting_location,
    payload.meeting_type,
    payload.meeting_title,
    payload.title
  );

  return {
    sourceEventId: firstNonEmpty(payload.event_id, payload.eventId, objectId ? `hubspot-meeting:${objectId}` : "", payload.callbackId),
    eventSource: "HubSpot",
    company: firstNonEmpty(
      company.name,
      company.company,
    contact.company,
      typeof payload.company === "string" ? payload.company : "",
      inputFields.company,
      inputFields.company_name,
      properties.company,
      payload.company_name
    ),
    firstName: firstNonEmpty(contact.first_name, inputFields.first_name, properties.firstname, payload.first_name, split.firstName),
    lastName: firstNonEmpty(contact.last_name, inputFields.last_name, properties.lastname, payload.last_name, split.lastName),
    email: firstNonEmpty(contact.email, inputFields.email, properties.email, payload.email),
    source: firstNonEmpty(inputFields.lead_source, properties.lead_source, payload.lead_source, "Outreach"),
    campaign: meetingType,
    owner: firstNonEmpty(
      owner.name,
      owner.full_name,
      owner.display_name,
      inputFields.owner_name,
      inputFields.host_name,
      inputFields.assignee_name,
      properties.hubspot_owner_name,
      payload.owner_name
    ),
    callDate: timestampValue(
      inputFields.call_date,
      inputFields.meeting_start_time,
      inputFields.start_time,
      properties.hs_meeting_start_time,
      properties.hs_timestamp,
      payload.start_time,
      payload.callDate
    ),
    callBookedOn: timestampValue(
      inputFields.booked_at,
      inputFields.createdate,
      properties.createdate,
      properties.hs_createdate,
      payload.booked_at,
      payload.created_at,
      payload.occurredAt
    ),
    callStatus: firstNonEmpty(inputFields.meeting_status, properties.hs_meeting_outcome, "Scheduled"),
    stage: "Call Booked",
    notes: firstNonEmpty(inputFields.notes, properties.hs_meeting_body, payload.notes)
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

module.exports = { bookingIncluded, normalizeBooking, normalizeHubSpotMeeting };
