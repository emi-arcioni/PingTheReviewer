import { createInterface } from "readline/promises";
import { styleText } from "util";
import { SLACK_TOKEN, DRY_RUN, AUTO_YES } from "./config.js";
import {
  loadSlackMap,
  getOpenPRs,
  openDMChannel,
  sendSlackMessage,
  buildMessage,
  formatApprovalStatus,
  hasAlreadyPinged,
} from "./helpers.js";

// Colors are dropped automatically when output isn't a terminal (or NO_COLOR is set).
const bold = (s) => styleText("bold", s);
const dim = (s) => styleText("dim", s);
const cyan = (s) => styleText("cyan", s);
const green = (s) => styleText("green", s);
const yellow = (s) => styleText("yellow", s);
const red = (s) => styleText("red", s);

const DIVIDER = dim("─".repeat(60));
const INDENT = "   ";

function kindLabel({ followUp, another }) {
  const parts = [followUp ? "🔁 follow-up" : "🆕 first ping"];
  if (another) parts.push("➕ another PR");
  return parts.join(dim(" · "));
}

async function confirm(rl, question) {
  const answer = await rl.question(`${question} ${dim("[y/N]")} `);
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  if (!SLACK_TOKEN && !DRY_RUN) {
    console.error(
      `${red("❌ SLACK_TOKEN env var is not set.")}\n` +
        "   Run with --dry-run to preview without sending, or set SLACK_TOKEN.\n" +
        "   See README.md for instructions on getting a token.",
    );
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(yellow("🧪 Dry run — nothing will be sent.\n"));
  }

  const slackMap = loadSlackMap();
  const prs = getOpenPRs();

  if (prs.length === 0) {
    console.log("📭 No open (non-draft) PRs found.");
    return;
  }

  console.log(bold(`🔍 Found ${prs.length} open PR(s)`));

  const rl =
    DRY_RUN || AUTO_YES
      ? null
      : createInterface({ input: process.stdin, output: process.stdout });

  // Reviewers we've already messaged during this run (for a different PR).
  const messagedThisRun = new Set();
  const stats = { pinged: 0, failed: 0, skippedPRs: 0 };

  const skip = (reason) => {
    console.log(`\n${INDENT}${dim(`⏭️  Skipping — ${reason}`)}`);
    stats.skippedPRs++;
  };

  try {
    for (const [i, pr] of prs.entries()) {
      console.log(`\n${DIVIDER}`);
      console.log(
        `📦 ${bold(`PR #${pr.number}`)} ${dim("·")} ${pr.title} ${dim(`[${i + 1}/${prs.length}]`)}`,
      );
      console.log(`${INDENT}🔗 ${cyan(pr.url)}`);
      console.log(`${INDENT}📊 ${formatApprovalStatus(pr.approvals)}`);

      if (pr.isInMergeQueue) {
        skip("already in merge queue");
        continue;
      }

      if (pr.reviewDecision === "APPROVED") {
        skip("already approved");
        continue;
      }

      const requestedCount = pr.reviewRequests.nodes.filter(
        (r) => r.requestedReviewer.login !== undefined,
      ).length;
      const { reviewers } = pr;

      if (requestedCount === 0) {
        skip("no reviewers requested");
        continue;
      }

      if (reviewers.length === 0) {
        skip("all reviewers already engaged");
        continue;
      }

      const label = (login) =>
        pr.reviewerNames[login]
          ? `${bold(login)} ${dim(`(${pr.reviewerNames[login]})`)}`
          : bold(login);

      // Step 1: work out which message each reviewer gets, before asking.
      console.log(`\n${INDENT}👥 ${bold("Reviewers")}`);
      const plan = [];
      for (const [j, ghUsername] of reviewers.entries()) {
        const last = j === reviewers.length - 1;
        const branch = dim(last ? "└─" : "├─");
        const pipe = dim(last ? "  " : "│ ");
        const slackId = slackMap[ghUsername];

        if (!slackId) {
          console.log(
            `${INDENT}${branch} 🚫 ${label(ghUsername)} ${dim("·")} ${yellow("no Slack ID found — won't be pinged")}`,
          );
          continue;
        }

        let channelId = null;
        let followUp = false;
        let warning = null;
        // Only touch Slack in dry-run if a token is available (read-only check).
        if (SLACK_TOKEN) {
          try {
            channelId = await openDMChannel(slackId);
            followUp = await hasAlreadyPinged(channelId, pr.url);
          } catch (err) {
            warning = `couldn't check previous pings (${err.message})`;
          }
        }

        const another = messagedThisRun.has(ghUsername);
        const message = buildMessage(pr, { followUp, another });
        const kind = kindLabel({ followUp, another });

        console.log(`${INDENT}${branch} ${label(ghUsername)} ${dim("·")} ${kind}`);
        // The URL is already shown above, so preview just the text line.
        console.log(`${INDENT}${pipe}    💬 ${dim(`"${message.split("\n")[0]}"`)}`);
        if (warning) {
          console.log(`${INDENT}${pipe}    ${yellow(`⚠️  ${warning}`)}`);
        }
        plan.push({ ghUsername, slackId, channelId, message, kind });
      }

      if (plan.length === 0) {
        skip("nobody to ping");
        continue;
      }

      console.log();
      if (
        rl &&
        !(await confirm(
          rl,
          `${INDENT}❓ ${bold(`Ping ${plan.length} reviewer(s) for PR #${pr.number}?`)}`,
        ))
      ) {
        console.log(`${INDENT}${dim("⏭️  Skipped.")}`);
        stats.skippedPRs++;
        continue;
      }

      // Step 2: send.
      for (const { ghUsername, slackId, channelId, message } of plan) {
        if (DRY_RUN) {
          console.log(`${INDENT}🧪 Would DM ${label(ghUsername)} ${dim(`[${slackId}]`)}`);
          messagedThisRun.add(ghUsername);
          stats.pinged++;
          continue;
        }
        try {
          const channel = channelId ?? (await openDMChannel(slackId));
          await sendSlackMessage(channel, message);
          messagedThisRun.add(ghUsername);
          stats.pinged++;
          console.log(`${INDENT}${green("✅ Pinged")} ${label(ghUsername)}`);
        } catch (err) {
          stats.failed++;
          console.error(
            `${INDENT}${red("❌ Failed to ping")} ${label(ghUsername)}${red(`: ${err.message}`)}`,
          );
        }
      }
    }
  } finally {
    rl?.close();
  }

  const verb = DRY_RUN ? "would be pinged" : "pinged";
  const summary = [
    green(`✅ ${stats.pinged} ${verb}`),
    stats.failed ? red(`❌ ${stats.failed} failed`) : null,
    dim(`⏭️  ${stats.skippedPRs} PR(s) skipped`),
  ]
    .filter(Boolean)
    .join(dim("  ·  "));
  console.log(`\n${DIVIDER}\n✨ ${bold("Done")}  ${summary}\n`);
}

main();
