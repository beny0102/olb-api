import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { CurrentAuth, AuthGuard, LogoutGuard } from "./auth.guard.js";
import type { AuthContext } from "./auth.service.js";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(body);
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
