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
  // Behind the scaled gateway the client IP is in X-Forwarded-For. Only trust
  // it when explicitly configured; a direct deployment must not trust it.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === "true" || trustProxy === "1") {
    app.set("trust proxy", 1);
  } else if (trustProxy && /^[1-9]\d*$/.test(trustProxy)) {
    app.set("trust proxy", Number(trustProxy));
  }
  // League bundles embed every roster entry and can exceed the 100kb default.
  app.useBodyParser("json", { limit: "10mb" });
  app.useGlobalFilters(new GameNotFoundFilter());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`olb-api listening on :${port}`);
}

await bootstrap();
