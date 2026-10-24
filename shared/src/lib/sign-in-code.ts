export const SIGN_IN_CODE_LENGTH = 8;

export function signInCodeDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, SIGN_IN_CODE_LENGTH);
}

// "12345678" → "1234 5678". The email and the code field both use it, so the
// code reads the same in both places.
export function groupSignInCode(digits: string): string {
  return digits.length > 4
    ? `${digits.slice(0, 4)} ${digits.slice(4)}`
    : digits;
}
