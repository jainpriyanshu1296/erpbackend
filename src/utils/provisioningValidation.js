function validateIdentity(input) {
  const details = {};
  if (typeof input.company_name !== 'string' || !input.company_name.trim())
    details.company_name = 'Company name is required';
  if (
    typeof input.owner_email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner_email)
  )
    details.owner_email = 'Enter a valid email address';
  if (
    !input.passwordHash &&
    (typeof input.password !== 'string' || input.password.length < 8)
  )
    details.password = 'Password must contain at least 8 characters';
  const field = input.subdomain !== undefined ? 'subdomain' : 'slug';
  if (
    typeof input[field] !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input[field])
  )
    details[field] = 'Use 1–63 lowercase letters, numbers or hyphens';
  if (Object.keys(details).length)
    throw Object.assign(
      new Error('Review the highlighted organization fields'),
      { status: 400, code: 'VALIDATION_ERROR', details },
    );
}
module.exports = { validateIdentity };
