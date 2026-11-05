import http from "node:http";

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal SSE reader for supertest-style tests. It keeps the connection open
 * and resolves each `data:` frame in order so a test can await a snapshot,
 * append through HTTP, then await the subsequent state without polling.
 */
export class SseClient {
  readonly ready: Promise<{ status: number; headers: http.IncomingHttpHeaders }>;

  private readonly request: http.ClientRequest;
  private response: http.IncomingMessage | null = null;
  private buffer = "";
  private readonly events: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(url: string) {
    this.ready = new Promise((resolve, reject) => {
      this.request = http.get(url, (response) => {
        this.response = response;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => this.onData(chunk));
        response.on("end", () => this.fail(new Error("SSE stream ended")));
        response.on("error", (error) => this.fail(error));
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
      this.request.on("error", (error) => {
        this.fail(error);
        reject(error);
      });
    });
  }

  async next(timeoutMs = 3000): Promise<unknown> {
    await this.ready;
    if (this.events.length > 0) return this.events.shift();
    if (this.closed) throw new Error("SSE stream is closed");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for an SSE event"));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  close(): void {
    this.closed = true;
    this.fail(new Error("SSE client closed"));
    this.response?.destroy();
    this.request.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.emitFrame(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  private emitFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) return;

    const event = JSON.parse(data) as unknown;
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    } else {
      this.events.push(event);
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}
