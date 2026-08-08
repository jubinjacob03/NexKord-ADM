import process from "node:process";
import { AkinatorClient } from "../src/games/akinator/akinatorClient.js";

const hardTimeoutMs = Number.parseInt(
  process.env.AKINATOR_TEST_HARD_TIMEOUT_MS || "25000",
  10,
);
const answerKey = process.env.AKINATOR_TEST_ANSWER || "yes";

const timer = setTimeout(
  () => {
    console.error(`[akinator:test] hard-timeout after ${hardTimeoutMs}ms`);
    process.exit(124);
  },
  Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0 ? hardTimeoutMs : 25000,
);

async function run() {
  const client = new AkinatorClient();
  try {
    const first = await client.startGame();
    console.log("[akinator:test] start", {
      type: first.type,
      step: first.step,
      progression: first.progression,
      question: first.question,
    });

    const next = await client.answer(answerKey);
    console.log("[akinator:test] answer", {
      answer: answerKey,
      type: next.type,
      step: next.step ?? null,
      progression: next.progression ?? null,
      question: next.question ?? null,
      name: next.name ?? null,
      description: next.description ?? null,
    });

    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[akinator:test] fail", message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}

await run();
process.exit(process.exitCode ?? 0);
