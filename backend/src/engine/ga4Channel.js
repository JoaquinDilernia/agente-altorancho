// Grupo de canales de GA4 (Default Channel Group) + fuente → nuestros canales.
const META_SOURCES = /(facebook|instagram|^fb$|^ig$|meta|messenger|whatsapp)/i;
const GOOGLE_PAID = new Set(['Paid Search', 'Paid Shopping', 'Cross-network', 'Paid Video', 'Display', 'Paid Other']);
const ORGANIC = new Set(['Organic Search', 'Direct', 'Referral', 'Organic Shopping', 'Organic Video']);

export function mapGa4Channel(group, source = '', medium = '') {
  if (!group || group === 'Unassigned' || group === '(not set)') return null;
  if (group === 'Paid Social') return META_SOURCES.test(source) ? 'meta' : 'other';
  if (GOOGLE_PAID.has(group)) return /google|youtube/i.test(source) || source === '' ? 'google' : 'other';
  if (group === 'Email') return 'email';
  if (group === 'Organic Social') return 'social_organic';
  if (ORGANIC.has(group)) return 'organic';
  if (/email/i.test(medium)) return 'email';
  return 'other';
}
