import { execSync } from "child_process";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import {
  GITHUB_REPO,
  GITHUB_USERNAME,
  SLACK_TOKEN,
  SLACK_MAP_PATH,
} from "./config.js";

export function loadSlackMap() {
  const raw = readFileSync(SLACK_MAP_PATH, "utf8");
  const parsed = yaml.load(raw);
  // Strip the leading "@" from Slack IDs (e.g. "@U089BBXUBA9" → "U089BBXUBA9")
  return Object.fromEntries(
    Object.entries(parsed).map(([gh, slack]) => [gh, slack.replace(/^@/, "")]),
  );
}

export function getOpenPRs() {
  const query = `{
    search(query: "repo:${GITHUB_REPO} is:pr is:open draft:false author:${GITHUB_USERNAME}", type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          number
          title
          url
          isInMergeQueue
          reviewDecision
          baseRef {
            rules(first: 50) {
              nodes {
                type
                parameters {
                  ... on PullRequestParameters {
                    requiredApprovingReviewCount
                    requireCodeOwnerReview
                  }
                }
              }
            }
          }
          latestOpinionatedReviews(first: 50, writersOnly: true) {
            nodes { state }
          }
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                ... on User { login name }
                ... on Team { name }
              }
            }
          }
          reviews(first: 50) {
            nodes { author { login } }
          }
          comments(first: 50) {
            nodes { author { login } }
          }
        }
      }
    }
  }`;

  const result = execSync(`gh api graphql -f query='${query}'`, {
    encoding: "utf8",
  });
  const { data } = JSON.parse(result);

  return data.search.nodes.map((pr) => {
    const alreadyEngaged = new Set([
      ...pr.reviews.nodes.map((r) => r.author.login),
      ...pr.comments.nodes.map((c) => c.author.login),
    ]);

    const reviewers = pr.reviewRequests.nodes
      .filter((r) => r.requestedReviewer.login !== undefined)
      .map((r) => r.requestedReviewer.login)
      .filter((login) => !alreadyEngaged.has(login));

    // GitHub login → real name from the user's profile (null if they haven't set one)
    const reviewerNames = Object.fromEntries(
      pr.reviewRequests.nodes
        .filter((r) => r.requestedReviewer.login !== undefined)
        .map((r) => [r.requestedReviewer.login, r.requestedReviewer.name]),
    );

    return {
      ...pr,
      reviewers,
      reviewerNames,
      approvals: getApprovalStatus(pr),
    };
  });
}

function getApprovalStatus(pr) {
  // Merge requirements come from the base branch's rulesets; take the strictest PR rule.
  const prRules = (pr.baseRef?.rules?.nodes ?? []).filter(
    (r) => r.type === "PULL_REQUEST",
  );
  const required = Math.max(
    0,
    ...prRules.map((r) => r.parameters?.requiredApprovingReviewCount ?? 0),
  );
  const codeOwnerRequired = prRules.some(
    (r) => r.parameters?.requireCodeOwnerReview,
  );
  const approved = pr.latestOpinionatedReviews.nodes.filter(
    (r) => r.state === "APPROVED",
  ).length;

  return { approved, required, codeOwnerRequired, decision: pr.reviewDecision };
}

export function formatApprovalStatus({
  approved,
  required,
  codeOwnerRequired,
  decision,
}) {
  const count = `${approved}/${required} approval(s)`;
  const owners = codeOwnerRequired ? " + code owner review" : "";

  switch (decision) {
    case "APPROVED":
      return `${count}${owners} — ✅ approved, ready to merge`;
    case "CHANGES_REQUESTED":
      return `${count}${owners} — ❌ changes requested`;
    case "REVIEW_REQUIRED": {
      const missing = Math.max(0, required - approved);
      const waiting =
        missing > 0
          ? `needs ${missing} more approval(s)${codeOwnerRequired ? " (incl. code owner)" : ""}`
          : "waiting on code owner review";
      return `${count}${owners} — ⏳ ${waiting}`;
    }
    default:
      return `${count}${owners}`;
  }
}

export async function openDMChannel(slackUserId) {
  const res = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: slackUserId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`conversations.open failed: ${data.error}`);
  return data.channel.id;
}

export async function sendSlackMessage(channelId, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
  return data;
}

let myUserIdPromise;
function getMyUserId() {
  myUserIdPromise ??= fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) throw new Error(`auth.test failed: ${data.error}`);
      return data.user_id;
    });
  return myUserIdPromise;
}

// True if we've already sent a message containing this PR's URL in the DM.
// Requires the `im:history` user scope.
export async function hasAlreadyPinged(channelId, prUrl) {
  const myUserId = await getMyUserId();
  let cursor;
  do {
    const params = new URLSearchParams({ channel: channelId, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } },
    );
    const data = await res.json();
    if (!data.ok) throw new Error(`conversations.history failed: ${data.error}`);
    if (
      data.messages.some(
        (m) => m.user === myUserId && m.text?.includes(prUrl),
      )
    ) {
      return true;
    }
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  return false;
}

// followUp: we already pinged this reviewer about this PR in a previous run.
// another:  we already messaged this reviewer about a different PR in this run.
export function buildMessage(pr, { followUp = false, another = false } = {}) {
  if (another && followUp) {
    return `And a reminder about this one too, if you can :pray:\n${pr.url}`;
  }
  if (another) {
    return `And one more, if you have a moment :sweat_smile: Thanks!\n${pr.url}`;
  }
  if (followUp) {
    return `Hey! Just a friendly reminder about this PR, whenever you get a chance :pray:\n${pr.url}`;
  }
  return `Hey! Could you please take a look at this PR when you get a chance? Thanks! :pray:\n${pr.url}`;
}
