import { Catch, type ExceptionFilter, type ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";
import { GameNotFoundError } from "../store/errors.js";

@Catch(GameNotFoundError)
export class GameNotFoundFilter implements ExceptionFilter<GameNotFoundError> {
  catch(exception: GameNotFoundError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(404).json({
      statusCode: 404,
      error: "Not Found",
      message: exception.message,
    });
  }
}
