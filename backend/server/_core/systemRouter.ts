import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  researchStatus: publicProcedure.query(async () => {
    const baseUrl = process.env.FASTAPI_URL || "http://127.0.0.1:8010";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        return {
          ok: false,
          reachable: false,
          source: baseUrl,
          message: `Research backend returned ${response.status}`,
        } as const;
      }

      const payload = (await response.json()) as {
        status?: string;
        elasticsearch_reachable?: boolean;
        elasticsearch_error?: string | null;
      };

      const backendOk = payload.status === "ok";
      const elasticsearchOk = payload.elasticsearch_reachable ?? false;

      return {
        ok: backendOk && elasticsearchOk,
        reachable: elasticsearchOk,
        source: baseUrl,
        message: backendOk
          ? elasticsearchOk
            ? "Research backend and Elasticsearch connected"
            : payload.elasticsearch_error || "FastAPI is running but Elasticsearch is unavailable"
          : "Research backend is responding unexpectedly",
      } as const;
    } catch {
      return {
        ok: false,
        reachable: false,
        source: baseUrl,
        message: "Research backend unavailable",
      } as const;
    } finally {
      clearTimeout(timeout);
    }
  }),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
