import { Hono } from "hono";
import { LambdaContext, LambdaEvent, streamHandle } from "hono/aws-lambda";
import {
  customProvider,
  defaultSettingsMiddleware,
  streamText,
  wrapLanguageModel,
} from "ai";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { LangfuseClient } from "@langfuse/client";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

type Bindings = {
  event: LambdaEvent;
  context: LambdaContext;
};

const app = new Hono<{ Bindings: Bindings }>();

const langfuseSpanProcessor = new LangfuseSpanProcessor();

const traceProvider = new NodeTracerProvider({
  spanProcessors: [langfuseSpanProcessor],
});

traceProvider.register({
  contextManager: new AsyncLocalStorageContextManager(),
});

const tracer = trace.getTracer("default");

const langfuse = new LangfuseClient();

const providers = customProvider({
  languageModels: {
    "amazon-nova-2-lite": wrapLanguageModel({
      model: bedrock("global.amazon.nova-2-lite-v1:0"),
      middleware: defaultSettingsMiddleware({
        settings: {
          maxOutputTokens: 65_535,
          providerOptions: {
            amazon: {
              additionalModelRequestFields: {},
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: "medium",
              },
              anthropicBeta: [],
            },
          },
        },
      }),
    }),
  },
});

app.get("/healthcheck", (c) => {
  return c.text("OK");
});

app.get("/stream", async (c) => {
  const span = tracer.startSpan("chat-message");

  const ctx = trace.setSpan(context.active(), span);
  return context.with(ctx, async () => {
    try {
      const prompt = await langfuse.prompt.get("default");

      const compiledPrompt = prompt.compile();

      span.setAttribute("input", compiledPrompt);
      span.setAttribute("gen_ai.prompt", compiledPrompt);

      const result = streamText({
        model: providers.languageModel("amazon-nova-2-lite"),
        prompt: compiledPrompt,
        // prompt: "This is a test prompt. Answer with your capabilities",
        experimental_telemetry: {
          isEnabled: true,
          functionId: "chat-message",
          metadata: {
            traceName: "chat-message",
            tags: ["production"],
            userId: "test-user-id",
            sessionId: "test-session-id",
          },
        },
        onFinish: async (result) => {
          try {
            span.setAttribute("output", result.text);
            span.setAttribute("gen_ai.completion", result.text);
          } finally {
            span.end();
            await langfuseSpanProcessor.forceFlush();
          }
        },
        onError: async (error) => {
          try {
            span.setAttribute("error", true);
          } finally {
            span.end();
            await langfuseSpanProcessor.forceFlush();
          }
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (err) {
      span.end();
      await langfuseSpanProcessor.forceFlush();
      throw err;
    }
  });
});

app.get("/aws-lambda-info", (c) => {
  return c.json({
    isBase64Encoded: c.env.event.isBase64Encoded,
    awsRequestId: c.env.context.awsRequestId,
  });
});

export const lambdaHandler = streamHandle(app);
