/**
 * Meta reports the same lead through several overlapping action types, and
 * which one appears depends on how the client captures leads: a form, the
 * pixel, or a WhatsApp/Messenger conversation. Agency clients mostly drive to
 * WhatsApp, so messaging conversions count as leads too.
 */
export const LEAD_ACTION_TYPES = [
  "lead",
  "leadgen_grouped",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.messaging_conversation_started_7d",
];

/**
 * Pull a single lead count out of an insights `actions[]` array.
 *
 * The max is taken rather than the sum: the types overlap, so adding them
 * would count the same conversation several times.
 */
export function extractLeadActions(actions: any): number {
  if (!Array.isArray(actions)) return 0;

  let max = 0;
  for (const action of actions) {
    if (LEAD_ACTION_TYPES.includes(action?.action_type)) {
      max = Math.max(max, Number(action.value || 0));
    }
  }
  return max;
}
