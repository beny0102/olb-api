import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { GameNotFoundFilter } from "./filters/game-not-found.filter.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });

  const origin = process.env.CORS_ORIGIN;
  app.enableCors({ origin: origin ? origin.split(",") : true });
  app.useGlobalFilters(new GameNotFoundFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`olb-api listening on :${port}`);
}

await bootstrap();
