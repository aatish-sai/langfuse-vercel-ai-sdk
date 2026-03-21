import { Hono } from "hono";
import { LambdaContext, LambdaEvent, streamHandle } from "hono/aws-lambda";
import { stream } from "hono/streaming";
import {
  customProvider,
  defaultSettingsMiddleware,
  streamText,
  wrapLanguageModel,
} from "ai";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { bedrock } from "@ai-sdk/amazon-bedrock";

type Bindings = {
  event: LambdaEvent;
  context: LambdaContext;
};

const app = new Hono<{ Bindings: Bindings }>();

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();

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
  const result = streamText({
    model: providers.languageModel("amazon-nova-2-lite"),
    prompt: "This is a test prompt. Answer with your capabilities",
    experimental_telemetry: {
      isEnabled: true,
    },
  });

  return stream(c, async (stream) => {
    for await (const textPart of result.textStream) {
      await stream.write(textPart);
    }

    await sdk.shutdown();
  });
});

app.get("/aws-lambda-info", (c) => {
  return c.json({
    isBase64Encoded: c.env.event.isBase64Encoded,
    awsRequestId: c.env.context.awsRequestId,
  });
});

export const lambdaHandler = streamHandle(app);
