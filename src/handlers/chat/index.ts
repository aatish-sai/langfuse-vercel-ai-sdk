import { Hono } from "hono";
import { LambdaContext, LambdaEvent, streamHandle } from "hono/aws-lambda";
import { stream } from "hono/streaming";
import { streamText } from "ai";

type Bindings = {
  event: LambdaEvent;
  context: LambdaContext;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/healthcheck", (c) => {
  return c.text("OK");
});

app.get("/stream", async (c) => {
  const result = streamText({
    model: "",
    prompt: "",
  });

  return stream(c, async (stream) => {
    for await (const textPart of result.textStream) {
      await stream.write(textPart);
    }
  });
});

app.get("/aws-lambda-info", (c) => {
  console.log(c);
  return c.json({
    isBase64Encoded: c.env.event.isBase64Encoded,
    awsRequestId: c.env.context.awsRequestId,
  });
});

export const lambdaHandler = streamHandle(app);
