// Completed years in the Philippines; February 29 advances March 1 in non-leap years.
function ageFromBirthdate(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const birth = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(birth.getTime()) || birth.getUTCFullYear() !== year ||
      birth.getUTCMonth() + 1 !== month || birth.getUTCDate() !== day) return null;
  const today = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let age = today.getUTCFullYear() - year;
  if (today.getUTCMonth() + 1 < month ||
      (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)) age--;
  return age < 0 ? null : age;
}

module.exports = { ageFromBirthdate };
