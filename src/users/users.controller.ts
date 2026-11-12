import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, CurrentAuth } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { UsersService } from "./users.service.js";

/** User and membership administration; every route requires `org_admin`. */
@Controller("admin")
@UseGuards(AuthGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get("users")
  listUsers(@CurrentAuth() auth: AuthContext) {
    return this.users.listUsers(auth);
  }

  @Post("users")
  createUser(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.users.createUser(auth, body);
  }

  @Patch("users/:id")
  updateUser(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.users.updateUser(auth, id, body);
  }

  @Post("users/:id/password")
  @HttpCode(200)
  setPassword(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.users.setPassword(auth, id, body);
  }

  @Get("memberships")
  listMemberships(
    @CurrentAuth() auth: AuthContext,
    @Query("userId") userId?: string,
  ) {
    return this.users.listMemberships(auth, userId);
  }

  @Post("memberships")
  createMembership(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.users.createMembership(auth, body);
  }

  @Delete("memberships/:id")
  deleteMembership(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.users.deleteMembership(auth, id);
  }
}
