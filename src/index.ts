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

interface RunResult {
  processed: string[];
  failed: Array<{ key: string; error: string }>;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyUpdate(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("OK");
    }

    const result = await runDailyUpdate(env);
    return Response.json(result, { status: result.failed.length === 0 ? 200 : 207 });
  },
};

async function runDailyUpdate(env: Env): Promise<RunResult> {
  const prefix = normalizePrefix(env.R2_UPDATE_PREFIX || "update/");
  const objects = await listAllObjects(env, prefix);
  const jsonObjects = objects.filter((object) => object.key.endsWith(".json"));
  const processed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const object of jsonObjects) {
    try {
      const source = await readR2Text(env, object.key);
      const ticket = JSON.parse(source) as JiraUpdate;
      validateTicket(ticket, object.key);
      await applyJiraUpdate(ticket, env);
      await moveR2Object(env, object.key, source, doneKey(env, object.key));
      processed.push(object.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed: ${object.key}`, error);
      failed.push({ key: object.key, error: message });

      if (env.MOVE_FAILED === "true") {
        await moveFailedObject(env, object.key, message);
      }
    }
  }

  console.log(`Jira daily update processed=${processed.length} failed=${failed.length}`);
  return { processed, failed };
}

async function listAllObjects(env: Env, prefix: string): Promise<R2ObjectInfo[]> {
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

    const response = await r2Fetch(env, "GET", "", query);
    const xml = await response.text();
    objects.push(...parseListBucketKeys(xml).map((key) => ({ key })));
    continuationToken = parseXmlTag(xml, "NextContinuationToken");
  } while (continuationToken);

  return objects;
}

async function readR2Text(env: Env, key: string): Promise<string> {
  const response = await r2Fetch(env, "GET", key);
  return response.text();
}

async function moveR2Object(env: Env, sourceKey: string, body: string, destinationKey: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    console.log(`DRY_RUN move ${sourceKey} -> ${destinationKey}`);
    return;
  }

  await r2Fetch(env, "PUT", destinationKey, undefined, body, {
    "content-type": "application/json; charset=utf-8",
  });
  await r2Fetch(env, "DELETE", sourceKey);
}

async function moveFailedObject(env: Env, sourceKey: string, error: string): Promise<void> {
  if (env.DRY_RUN === "true") {
    return;
  }

  try {
    const source = await readR2Text(env, sourceKey);
    await r2Fetch(env, "PUT", failedKey(env, sourceKey), undefined, source, {
      "content-type": "application/json; charset=utf-8",
      "x-amz-meta-error": error.slice(0, 512),
    });
    await r2Fetch(env, "DELETE", sourceKey);
  } catch (moveError) {
    console.error(`Failed to move failed object ${sourceKey}`, moveError);
  }
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

async function r2Fetch(
  env: Env,
  method: string,
  key: string,
  query: Record<string, string> = {},
  body = "",
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${env.R2_BUCKET_NAME}${key ? `/${key}` : ""}`;
  const url = new URL(`https://${host}${encodePath(path)}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }

  const payloadHash = await sha256Hex(body);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...lowercaseKeys(extraHeaders),
  };
  headers.authorization = await authorizationHeader(env, method, path, query, headers, payloadHash, dateStamp, amzDate);

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "DELETE" ? undefined : body,
  });

  if (!response.ok) {
    throw new Error(`R2 API failed ${method} ${key || "/"}: ${response.status} ${await response.text()}`);
  }

  return response;
}

async function authorizationHeader(
  env: Env,
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
  dateStamp: string,
  amzDate: string,
): Promise<string> {
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const canonicalRequest = [
    method,
    encodePath(path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSignatureKey(env.R2_SECRET_ACCESS_KEY, dateStamp);
  const signature = await hmacHex(signingKey, stringToSign);

  return [
    `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
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

function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");
}

function encodePath(path: string): string {
  return path.split("/").map(awsEncode).join("/");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

async function hmacHex(key: ArrayBuffer | Uint8Array, value: string): Promise<string> {
  return toHex(await hmac(key, value));
}

async function getSignatureKey(secret: string, dateStamp: string): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseListBucketKeys(xml: string): string[] {
  return [...xml.matchAll(/<Contents>[\s\S]*?<Key>(.*?)<\/Key>[\s\S]*?<\/Contents>/g)].map((match) => decodeXml(match[1]));
}

function parseXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
  return match ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
