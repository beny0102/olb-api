import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { CurrentAuth, AuthGuard, LogoutGuard } from "./auth.guard.js";
import type { AuthContext } from "./auth.service.js";
import { AuthService } from "./auth.service.js";
import { LoginRateLimiter } from "./login-rate-limit.js";

function loginEmail(body: unknown): string {
  if (typeof body !== "object" || body === null || !("email" in body)) return "";
  const email = (body as { email?: unknown }).email;
  return typeof email === "string" ? email : "";
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Ip() ip: string) {
    const email = loginEmail(body);
    this.limiter.assertAllowed(ip, email);
    try {
      const result = await this.auth.login(body);
      this.limiter.recordSuccess(ip, email);
      return result;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        this.limiter.recordFailure(ip, email);
      }
      throw error;
    }
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentAuth() auth: AuthContext) {
    return { user: auth.user, memberships: auth.memberships };
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(LogoutGuard)
  async logout(@CurrentAuth() auth: AuthContext) {
    await this.auth.logout(auth.token);
    return { loggedOut: true };
  }
}
