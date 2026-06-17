import { execSync } from "child_process";
import { readFileSync } from "fs";
import yaml from "js-yaml";
import { GITHUB_REPO, GITHUB_USERNAME, SLACK_TOKEN, SLACK_MAP_PATH } from "./config.js";

export function loadSlackMap() {
  const raw = readFileSync(SLACK_MAP_PATH, "utf8");
  const parsed = yaml.load(raw);
  // Strip the leading "@" from Slack IDs (e.g. "@U089BBXUBA9" → "U089BBXUBA9")
  return Object.fromEntries(
    Object.entries(parsed).map(([gh, slack]) => [gh, slack.replace(/^@/, "")])
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
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                ... on User { login }
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

  const result = execSync(`gh api graphql -f query='${query}'`, { encoding: "utf8" });
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

    return { ...pr, reviewers };
  });
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

export function buildMessage(pr) {
  return `Hey! Could you please take a look at this PR when you get a chance? Thanks! :pray:\n${pr.url}`;
}
