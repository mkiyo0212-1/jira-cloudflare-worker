import { AwsClient } from "aws4fetch";

export interface Env {
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_UPDATE_PREFIX?: string;
  R2_DONE_PREFIX?: string;
  R2_FAILED_PREFIX?: string;
  JIRA_BASE_URL: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_SPRINT_FIELD?: string;
  ALLOWED_RUN_IPS?: string;
  MOVE_FAILED?: string;
  DRY_RUN?: string;
}

interface JiraMention {
  name: string;
  jira_id?: string;
  team_id?: string;
}

interface JiraUpdate {
  issue: string;
  assignee?: string;
  status?: number;
  sprint?: number;
  labels?: string[];
  comment?: {
    to?: JiraMention;
    body?: string;
    cc?: JiraMention[];
  };
}

interface R2ObjectInfo {
  key: string;
}

interface R2Client {
  endpoint: string;
  bucket: string;
  client: AwsClient;
}

interface RunResult {
  processed: string[];
  failed: Array<{ key: string; error: string }>;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyUpdate(env).catch((error) => console.error("Scheduled run failed", error)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("OK");
    }
    if (!isAllowedRunRequest(request, env)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const result = await runDailyUpdate(env);
      return Response.json(result, { status: result.failed.length === 0 ? 200 : 207 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Manual run failed", error);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};

async function runDailyUpdate(env: Env): Promise<RunResult> {
  const r2 = r2Client(env);
  const prefix = normalizePrefix(env.R2_UPDATE_PREFIX || "update/");
  const objects = await listAllObjects(r2, env, prefix);
  const jsonObjects = objects.filter((object) => object.key.endsWith(".json"));
  const processed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const object of jsonObjects) {
    try {
      const source = await readR2Text(r2, env, object.key);
      const ticket = JSON.parse(source) as JiraUpdate;
      validateTicket(ticket, object.key);
      await applyJiraUpdate(ticket, env);
      await moveR2Object(r2, env, object.key, source, doneKey(env, object.key));
      processed.push(object.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed: ${object.key}`, error);
      failed.push({ key: object.key, error: message });

      if (env.MOVE_FAILED === "true") {
        await moveFailedObject(r2, env, object.key, message);
      }
    }
  }

  console.log(`Jira daily update processed=${processed.length} failed=${failed.length}`);
  return { processed, failed };
}

function r2Client(env: Env): R2Client {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return {
    endpoint: `https://${host}`,
    bucket: env.R2_BUCKET_NAME,
    client: new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
  };
}

async function listAllObjects(r2: R2Client, env: Env, prefix: string): Promise<R2ObjectInfo[]> {
  const objects: R2ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix,
    };
    if (continuationToken) {
      query["continuation-token"] = continuationToken;
    }

    const response = await r2Fetch(r2, "GET", undefined, query);
    const xml = await response.text();
    for (const key of xmlMatches(xml, "Key")) {
      objects.push({ key });
    }
    continuationToken = xmlValue(xml, "NextContinuationToken");
  } while (continuationToken);

  return objects;
}

async function readR2Text(r2: R2Client, _env: Env, key: string): Promise<string> {
  const response = await r2Fetch(r2, "GET", key);
  return response.text();
}

async function moveR2Object(r2: R2Client, env: Env, sourceKey: string, body: string, destinationKey: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    console.log(`DRY_RUN move ${sourceKey} -> ${destinationKey}`);
    return;
  }

  await r2Fetch(r2, "PUT", destinationKey, undefined, body, {
    "content-type": "application/json; charset=utf-8",
  });
  await r2Fetch(r2, "DELETE", sourceKey);
}

async function moveFailedObject(r2: R2Client, env: Env, sourceKey: string, error: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    return;
  }

  try {
    const source = await readR2Text(r2, env, sourceKey);
    await r2Fetch(r2, "PUT", failedKey(env, sourceKey), undefined, source, {
      "content-type": "application/json; charset=utf-8",
      "x-amz-meta-error": error.slice(0, 512),
    });
    await r2Fetch(r2, "DELETE", sourceKey);
  } catch (moveError) {
    console.error(`Failed to move failed object ${sourceKey}`, moveError);
  }
}

async function r2Fetch(
  r2: R2Client,
  method: string,
  key?: string,
  query?: Record<string, string>,
  body = "",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const path = key ? `/${r2.bucket}/${encodePath(key)}` : `/${r2.bucket}`;
  const canonicalQuery = canonicalQueryString(query);
  const url = `${r2.endpoint}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const response = await r2.client.fetch(url, {
    method,
    headers: extraHeaders,
    body: method === "GET" || method === "DELETE" ? undefined : body,
    aws: {
      allHeaders: true,
    },
  });

  if (!response.ok) {
    throw new Error(`R2 API failed ${method} ${path}: ${response.status} ${await response.text()}`);
  }

  return response;
}

function canonicalQueryString(query?: Record<string, string>): string {
  if (!query) {
    return "";
  }

  return Object.entries(query)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function encodePath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xmlValue(xml: string, tag: string): string | undefined {
  return xmlMatches(xml, tag)[0];
}

function xmlMatches(xml: string, tag: string): string[] {
  const matches: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    matches.push(decodeXml(match[1]));
  }
  return matches;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function applyJiraUpdate(ticket: JiraUpdate, env: Env): Promise<void> {
  if (env.DRY_RUN === "true") {
    console.log("DRY_RUN", JSON.stringify(ticket));
    return;
  }

  if (ticket.assignee) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ accountId: ticket.assignee }),
    });
  }

  if (typeof ticket.status === "number") {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: String(ticket.status) } }),
    });
  }

  const fields: Record<string, unknown> = {};
  if (typeof ticket.sprint === "number" && env.JIRA_SPRINT_FIELD) {
    fields[env.JIRA_SPRINT_FIELD] = ticket.sprint;
  }

  const labels = uniqueLabels(ticket.labels ?? []);
  const update: Record<string, unknown[]> = {};
  if (labels.length > 0) {
    update.labels = labels.map((label) => ({ add: label }));
  }

  if (Object.keys(fields).length > 0 || Object.keys(update).length > 0) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}`, {
      method: "PUT",
      body: JSON.stringify({ fields, update }),
    });
  }

  if (ticket.comment?.body) {
    await jiraFetch(env, `/rest/api/3/issue/${ticket.issue}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: toAtlassianDoc(ticket.comment) }),
    });
  }
}

async function jiraFetch(env: Env, path: string, init: RequestInit): Promise<void> {
  const response = await fetch(`${env.JIRA_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Authorization": `Basic ${btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`)}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Jira API failed ${path}: ${response.status} ${await response.text()}`);
  }
}

function toAtlassianDoc(comment: NonNullable<JiraUpdate["comment"]>): unknown {
  const content = [];
  const mentions = [comment.to, ...(comment.cc ?? [])].filter((mention): mention is JiraMention => Boolean(mention?.jira_id));

  if (mentions.length > 0) {
    content.push({
      type: "paragraph",
      content: mentions.flatMap((mention, index) => [
        ...(index === 0 ? [] : [{ type: "text", text: " " }]),
        { type: "mention", attrs: { id: mention.jira_id, text: `@${mention.name}` } },
      ]),
    });
  }

  for (const line of comment.body?.split("\n") ?? []) {
    content.push({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    });
  }

  return {
    type: "doc",
    version: 1,
    content,
  };
}

function validateTicket(ticket: JiraUpdate, key: string): void {
  if (!ticket.issue) {
    throw new Error(`${key}: issue is required`);
  }
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const label of labels) {
    const normalized = label.toLocaleLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(label);
    }
  }

  return unique;
}

function doneKey(env: Env, sourceKey: string): string {
  const prefix = datedPrefix(env.R2_DONE_PREFIX || "done/");
  return `${prefix}${baseName(sourceKey)}`;
}

function failedKey(env: Env, sourceKey: string): string {
  const prefix = datedPrefix(env.R2_FAILED_PREFIX || "failed/");
  return `${prefix}${timestamp()}-${baseName(sourceKey)}`;
}

function datedPrefix(prefix: string): string {
  return `${normalizePrefix(prefix)}${new Date().toISOString().slice(0, 10)}/`;
}

function normalizePrefix(value: string): string {
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function baseName(key: string): string {
  return key.split("/").filter(Boolean).at(-1) || key;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isAllowedRunRequest(request: Request, env: Env): boolean {
  const allowedIps = (env.ALLOWED_RUN_IPS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  if (allowedIps.length === 0) {
    return false;
  }

  const clientIp = request.headers.get("CF-Connecting-IP");
  return Boolean(clientIp && allowedIps.includes(clientIp));
}
