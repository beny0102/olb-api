import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { seedAuth, SEED_AUTH_EMAILS } from "../../src/auth/auth-seed.js";
import { AUTH_STORE } from "../../src/auth/auth.store.js";

export const ADMIN_EMAIL = SEED_AUTH_EMAILS[0];
export const ADMIN_PASSWORD = "olb-demo-admin";
export const NORTE_EMAIL = SEED_AUTH_EMAILS[1];
export const NORTE_PASSWORD = "olb-demo-norte";
export const TIBURONES_EMAIL = SEED_AUTH_EMAILS[2];
export const TIBURONES_PASSWORD = "olb-demo-tiburones";
export const VERIFIER_EMAIL = SEED_AUTH_EMAILS[3];
export const VERIFIER_PASSWORD = "olb-demo-verificador";

/** Seeds the demo identities into the memory auth store of `app`. */
export async function seedTestAuth(app: INestApplication): Promise<void> {
  await seedAuth(app.get(AUTH_STORE));
}

/** Logs in through the real endpoint and returns the bearer token. */
export async function login(
  app: INestApplication,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ email, password })
    .expect(200);
  return response.body.token as string;
}
