import { Body, Controller, Get, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { SetupService } from "./setup.service.js";

export function clientIp(request: Request): string {
  // Do not trust X-Forwarded-For here: the API is normally exposed directly,
  // and a spoofable header would let a caller bypass the attempt limit.
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

@Controller("setup")
export class SetupController {
  constructor(@Inject(SetupService) private readonly setup: SetupService) {}

  @Get("status")
  status() {
    return this.setup.status();
  }

  @Post()
  create(@Body() body: unknown, @Req() request: Request) {
    return this.setup.setup(body, clientIp(request));
  }
}
