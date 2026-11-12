import { BadRequestException } from "@nestjs/common";

export const MIN_PASSWORD_LENGTH = 10;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Admin-set passwords only; login never enforces a policy. */
export function assertPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestException(
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > 200) {
    throw new BadRequestException("password must be at most 200 characters");
  }
  return password;
}

/** Basic shape check; the unique constraint and login are the real gates. */
export function assertEmail(email: string): string {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL.test(trimmed)) {
    throw new BadRequestException("email must be a valid address");
  }
  return trimmed;
}
