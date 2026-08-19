import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const profileDir = path.join(dataDir, "browser-profile");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Fresh profile each run so you can log into a different account
if (fs.existsSync(profileDir)) {
  fs.rmSync(profileDir, { recursive: true, force: true });
}

export async function grabDiscordToken() {
  console.log("Launching browser for Discord login...");
  console.log(
    "You have 10 minutes to complete login, 2FA, or captchas in the opened window.",
  );

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  let capturedToken = null;

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const headers = request.headers();
    if (
      headers["authorization"] &&
      !headers["authorization"].startsWith("Bot ")
    ) {
      capturedToken = headers["authorization"];
    }
    request.continue();
  });

  await page.goto("https://discord.com/login", { waitUntil: "networkidle2" });

  const timeout = 600000;
  const startTime = Date.now();

  while (!capturedToken && Date.now() - startTime < timeout) {
    try {
      const evalToken = await page.evaluate(() => {
        try {
          return (
            window.webpackChunkdiscord_app.push([
              [""],
              {},
              (e) => {
                for (const m of Object.values(e.c)) {
                  if (m?.exports?.default?.getToken)
                    return m.exports.default.getToken();
                }
              },
            ]) || localStorage.getItem("token")?.replace(/"/g, "")
          );
        } catch {
          return localStorage.getItem("token")?.replace(/"/g, "");
        }
      });
      if (evalToken && evalToken !== "null") {
        capturedToken = evalToken;
        break;
      }
    } catch {
      // Retry in loop
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await browser.close();

  if (!capturedToken) {
    throw new Error(
      "Token capture timed out (10 minutes exceeded). Try again.",
    );
  }

  console.log("\n========================================");
  console.log("  TOKEN CAPTURED — COPY IT NOW");
  console.log("========================================");
  console.log(capturedToken);
  console.log("========================================\n");

  return capturedToken;
}

if (process.argv[1]?.endsWith("token-grabber.js")) {
  grabDiscordToken().catch((err) => {
    console.error("Token grabber error:", err.message);
    process.exit(1);
  });
}
