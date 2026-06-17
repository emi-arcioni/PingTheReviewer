import { SLACK_TOKEN, DRY_RUN } from "./config.js";
import {
  loadSlackMap,
  getOpenPRs,
  openDMChannel,
  sendSlackMessage,
  buildMessage,
} from "./helpers.js";

async function main() {
  if (!SLACK_TOKEN && !DRY_RUN) {
    console.error(
      "Error: SLACK_TOKEN env var is not set.\n" +
        "Run with --dry-run to preview without sending, or set SLACK_TOKEN.\n" +
        "See README.md for instructions on getting a token."
    );
    process.exit(1);
  }

  const slackMap = loadSlackMap();
  const prs = getOpenPRs();

  if (prs.length === 0) {
    console.log("No open (non-draft) PRs found.");
    return;
  }

  console.log(`Found ${prs.length} open PR(s):\n`);

  for (const pr of prs) {
    console.log(`PR #${pr.number}: ${pr.title}`);
    console.log(`  URL: ${pr.url}`);

    if (pr.isInMergeQueue) {
      console.log("  Already in merge queue — skipping.\n");
      continue;
    }

    const requestedCount = pr.reviewRequests.nodes.filter(
      (r) => r.requestedReviewer.login !== undefined
    ).length;
    const { reviewers } = pr;

    if (requestedCount === 0) {
      console.log("  No reviewers requested — skipping.\n");
      continue;
    }

    if (reviewers.length === 0) {
      console.log("  All reviewers already engaged — skipping.\n");
      continue;
    }

    console.log(`  Reviewers: ${reviewers.join(", ")}`);

    for (const ghUsername of reviewers) {
      const slackId = slackMap[ghUsername];

      if (!slackId) {
        console.log(`  [!] No Slack ID found for GitHub user: ${ghUsername}`);
        continue;
      }

      const message = buildMessage(pr);

      if (DRY_RUN) {
        console.log(`  [dry-run] Would DM ${ghUsername} (${slackId}):`);
        console.log(`    "${message}"`);
      } else {
        try {
          const channelId = await openDMChannel(slackId);
          await sendSlackMessage(channelId, message);
          console.log(`  Pinged ${ghUsername} on Slack.`);
        } catch (err) {
          console.error(`  Failed to ping ${ghUsername}: ${err.message}`);
        }
      }
    }
    console.log();
  }
}

main();
