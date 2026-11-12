import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { AuthGuard, CurrentAuth } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { TransferService } from "./transfer.service.js";

function parseDryRun(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new BadRequestException("dryRun must be true or false");
}

@Controller("admin")
@UseGuards(AuthGuard)
export class TransferController {
  constructor(@Inject(TransferService) private readonly transfer: TransferService) {}

  @Get("export")
  async exportLeague(
    @CurrentAuth() auth: AuthContext,
    @Query("seasonId") seasonId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.transfer.exportLeague(auth, seasonId);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.fileName}"`,
    );
    return result.bundle;
  }

  @Post("import")
  async importLeague(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Query("dryRun") dryRun: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsedDryRun = parseDryRun(dryRun);
    const result = await this.transfer.importLeague(auth, body, parsedDryRun);
    response.status(parsedDryRun ? 200 : 201);
    return result;
  }
}
