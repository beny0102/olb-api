import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { GameNotFoundFilter } from "./filters/game-not-found.filter.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn", "log"],
  });

  const origin = process.env.CORS_ORIGIN;
  app.enableCors({ origin: origin ? origin.split(",") : true });
  // League bundles embed every roster entry and can exceed the 100kb default.
  app.useBodyParser("json", { limit: "10mb" });
  app.useGlobalFilters(new GameNotFoundFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`olb-api listening on :${port}`);
}

await bootstrap();
